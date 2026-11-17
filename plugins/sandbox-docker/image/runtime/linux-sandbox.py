import ctypes
import errno
import importlib.util
import ipaddress
import json
import os
import platform
import select
import signal
import socket
import stat
import struct
import sys
import threading
import time

# Restricted Linux launcher and syscall broker. The trusted consumer pins every granted root once
# (an inherited directory descriptor plus its device/inode identity) and passes it here. Landlock
# rules, the broker's metadata checks and the native-file helper all use exactly those
# descriptors; root pathnames are never reopened. Anything unsupported reports unavailable.
#
# Documented behaviour of restricted execution:
# - Metadata reads outside the roots are not mediated: stat/statx, access, readlink, getxattr,
#   listxattr, statfs, inotify marks and other processes' /proc cmdline can reveal names, sizes,
#   times, link targets and xattr values. File contents, writes and metadata changes are confined.
# - Known limitation: /proc stays a read root, so a restricted command can read the world-readable
#   entries of other processes of the same uid, including /proc/<pid>/cmdline of a concurrent Full
#   command (secrets inlined in a command line are visible). Ptrace-guarded entries (environ, mem,
#   maps, fd) stay closed by Landlock's ptrace scoping. Landlock cannot narrow /proc to the
#   command's own tree: /proc/self resolves to per-process directories that exist only after the
#   rules are set, so dropping /proc (keeping cpuinfo, meminfo, stat and the like) also denies a
#   process its own /proc/self, which ordinary tools need (Node's process.memoryUsage(), Python's
#   /proc/self/fd and /proc/self/maps reads). hidepid needs a mount and PID namespaces need new
#   privileges, both outside this launcher's design. Consumers keep secrets out of command lines.
# - Network none/allowlist: TCP sockets may bind and listen on loopback (127.0.0.1, ::1) only;
#   connections go only to the endpoints the consumer granted. Environment lifts that filter.
# - UNIX sockets in every network kind: stream/seqpacket only (datagram and raw are refused);
#   pathname connect/bind only to sockets inside the write roots, resolved through the pinned
#   descriptors; abstract and unnamed addresses are refused. socketpair() is unaffected.
# - The launcher creates one closed session (setsid is denied inside it) and reports it in a
#   "session" event; if the supervisor is lost, the consumer runs "reap" with that event to end
#   every owned process. Brokered calls fail (ENOSYS) once the broker is gone.
#
# Architecture validation: an architecture reports restricted support only when it is listed in
# VALIDATED_ARCHES, which an evidence commit changes after the real-kernel conformance suite
# passed on that architecture (the commit cites the run). Until then a consumer may pass
# "candidateArch" (probe --candidate-arch) to run the reviewed table for evidence collection
# only; production consumers never set it.

LANDLOCK_ABI_REQUIRED = 6
# aarch64: Docker 29.9.3 on Linux 7.0.14-linuxkit (Landlock ABI 8), reviewed conformance runs.
# x86_64: GitHub Actions run 43906202355 on Linux 7.0.0-1019-azure, LSM list with landlock,
#   Docker builtin seccomp, image capybara-sandbox@sha256:0473fbbc... amd64: 19 passed, 1 guard
#   skipped, with CAPYBARA_TEST_REQUIRE_LINUX_RESTRICTED=1 (no mechanism test skipped).
VALIDATED_ARCHES = ("aarch64", "x86_64")
# Every syscall above this number (newer than the reviewed inventory) fails with ENOSYS.
MAX_KNOWN_SYSCALL = 469

ARCHES = {
    "aarch64": {
        "audit": 0xC00000B7,
        "seccomp": 277,
        "nr": {
            "setxattr": 5, "lsetxattr": 6, "fsetxattr": 7, "removexattr": 14,
            "lremovexattr": 15, "fremovexattr": 16, "ioctl": 29, "fchmod": 52, "fchmodat": 53,
            "fchownat": 54, "fchown": 55, "utimensat": 88, "unshare": 97, "setsid": 157,
            "socket": 198, "socketpair": 199, "bind": 200, "listen": 201, "connect": 203, "sendto": 206,
            "sendmsg": 211, "add_key": 217, "request_key": 218, "keyctl": 219, "clone": 220,
            "setns": 268, "sendmmsg": 269, "userfaultfd": 282,
        },
    },
    "x86_64": {
        "audit": 0xC000003E,
        "seccomp": 317,
        "x32": True,
        "nr": {
            "ioctl": 16, "socket": 41, "connect": 42, "sendto": 44, "sendmsg": 46, "bind": 49,
            "listen": 50, "socketpair": 53, "clone": 56, "chmod": 90, "fchmod": 91, "chown": 92, "fchown": 93,
            "lchown": 94, "setsid": 112, "utime": 132, "uselib": 134, "setxattr": 188,
            "lsetxattr": 189, "fsetxattr": 190, "removexattr": 197, "lremovexattr": 198,
            "fremovexattr": 199, "utimes": 235, "add_key": 248, "request_key": 249,
            "keyctl": 250, "fchownat": 260, "futimesat": 261, "fchmodat": 268, "unshare": 272,
            "utimensat": 280, "sendmmsg": 307, "setns": 308, "userfaultfd": 323,
        },
    },
}
COMMON = {"io_uring_setup": 425, "io_uring_enter": 426, "io_uring_register": 427,
          "clone3": 435, "fchmodat2": 452, "setxattrat": 463, "removexattrat": 466,
          "file_setattr": 469}
NR_CLOSE_RANGE = 436
# CLONE_NEWNS | NEWCGROUP | NEWUTS | NEWIPC | NEWUSER | NEWPID | NEWNET | NEWTIME
NAMESPACE_FLAGS = 0x7E020080
NR_PIDFD_OPEN = 434
NR_PIDFD_SEND_SIGNAL = 424
NR_LANDLOCK_CREATE = 444
NR_LANDLOCK_ADD = 445
NR_LANDLOCK_RESTRICT = 446

FS_EXECUTE, FS_WRITE_FILE, FS_READ_FILE, FS_READ_DIR = 1, 2, 4, 8
FS_TRUNCATE, FS_IOCTL_DEV = 1 << 14, 1 << 15
FS_ALL = (1 << 16) - 1
FS_READ = FS_EXECUTE | FS_READ_FILE | FS_READ_DIR
FS_DEVICE = FS_READ_FILE | FS_WRITE_FILE | FS_TRUNCATE | FS_IOCTL_DEV
NET_CONNECT_TCP = 2
# LANDLOCK_ACCESS_NET_BIND_TCP | CONNECT_TCP: only the broker binds or connects TCP sockets.
NET_MEDIATED = 1 | 2
SCOPE_ALL = 1 | 2  # abstract UNIX sockets and signals stay inside the domain
DEFAULT_SYSTEM_ROOTS = ("/usr", "/bin", "/sbin", "/lib", "/lib64", "/etc", "/proc")
DEVICE_FILES = ("/dev/null", "/dev/zero", "/dev/full", "/dev/random", "/dev/urandom", "/dev/tty")

RET_ALLOW, RET_NOTIFY, RET_KILL = 0x7FFF0000, 0x7FC00000, 0x80000000
def RET_ERRNO(code):
    return 0x00050000 | code

# File-attribute, encryption-policy and terminal-injection ioctls that mutate an object the
# descriptor may only read. Landlock's IOCTL_DEV right does not cover regular files.
DENIED_IOCTLS = (0x5412, 0x541C, 0x40086602, 0x40046602, 0x401C5820, 0x40087602, 0x40047602,
                 0x800C6613, 0xC0406618, 0xC0186619, 0xC040661A)
MSG_FASTOPEN = 0x20000000
# Linux socket ABI values (identical on every architecture this launcher knows).
AF_UNSPEC, AF_UNIX, AF_INET, AF_INET6, AF_NETLINK = 0, 1, 2, 10, 16
SOCK_STREAM, SOCK_DGRAM, SOCK_SEQPACKET = 1, 2, 5
SOCK_NONBLOCK, SOCK_CLOEXEC = 0o4000, 0o2000000
SOL_SOCKET, SO_DOMAIN, IPPROTO_TCP = 1, 39, 6
AT_FDCWD = -100
AT_SYMLINK_NOFOLLOW = 0x100
AT_EMPTY_PATH = 0x1000
NOTIF_RECV, NOTIF_SEND, NOTIF_ID_VALID, NOTIF_ADDFD = 0xC0502100, 0xC0182101, 0x40082102, 0x40182103
ADDFD_SEND = 2

libc = ctypes.CDLL(None, use_errno=True)
libc.syscall.restype = ctypes.c_long
libc.ioctl.restype = ctypes.c_int
libc.ioctl.argtypes = (ctypes.c_int, ctypes.c_ulong, ctypes.c_void_p)


class Refused(Exception):
    def __init__(self, code, message):
        super().__init__(message)
        self.code = code


def syscall(nr, *args):
    result = libc.syscall(ctypes.c_long(nr), *[ctypes.c_long(a) if isinstance(a, int) else a
                                                for a in args])
    if result < 0:
        code = ctypes.get_errno()
        raise OSError(code, os.strerror(code))
    return result


def ioctl(fd, request, buffer):
    if libc.ioctl(fd, request, buffer) < 0:
        code = ctypes.get_errno()
        raise OSError(code, os.strerror(code))


def load_native():
    path = os.path.join(os.path.dirname(os.path.abspath(__file__)), "native-files.py")
    spec = importlib.util.spec_from_file_location("capybara_native_files", path)
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module, path


def arch():
    machine = platform.machine()
    return machine, ARCHES.get(machine)


def landlock_abi():
    value = libc.syscall(ctypes.c_long(NR_LANDLOCK_CREATE), None, ctypes.c_long(0),
                         ctypes.c_long(1))
    return value if value > 0 else 0


# ---- seccomp filter -----------------------------------------------------------------------

class Program:
    def __init__(self):
        self.code = []
        self.labels = {}

    def label(self, name):
        self.labels[name] = len(self.code)

    def ld(self, offset):
        self.code.append((0x20, 0, 0, offset))

    def ld_nr(self):
        self.ld(0)

    def ld_arg(self, index):
        self.ld(16 + 8 * index)

    def ret(self, value):
        self.code.append((0x06, 0, 0, value))

    def alu_and(self, value):
        self.code.append((0x54, 0, 0, value))

    def jump(self, op, value, true, false=None):
        self.code.append((op, true, false, value))

    def jeq(self, value, true, false=None):
        self.jump(0x15, value, true, false)

    def jgt(self, value, true, false=None):
        self.jump(0x25, value, true, false)

    def jge(self, value, true, false=None):
        self.jump(0x35, value, true, false)

    def jset(self, value, true, false=None):
        self.jump(0x45, value, true, false)

    def assemble(self):
        out = bytearray()
        for index, (code, true, false, value) in enumerate(self.code):
            def target(name):
                if name is None:
                    return 0
                offset = self.labels[name] - index - 1
                if not 0 <= offset <= 255:
                    raise ValueError("seccomp jump out of range")
                return offset
            if code & 0x07 == 0x05:
                out += struct.pack("HBBI", code, target(true), target(false), value)
            else:
                out += struct.pack("HBBI", code, 0, 0, value)
        return bytes(out)


def build_filter(table, network_mediated, brokered):
    """The restricted child's filter. Brokered calls go to the supervisor (EACCES without one)."""
    nr = dict(table["nr"], **COMMON)
    notify = RET_NOTIFY if brokered else RET_ERRNO(errno.EACCES)
    p = Program()
    p.ld(4)
    p.jeq(table["audit"], "arch_ok")
    p.ret(RET_KILL)
    p.label("arch_ok")
    p.ld_nr()
    if table.get("x32"):
        p.jge(0x40000000, "enosys")
    p.jgt(MAX_KNOWN_SYSCALL, "enosys")
    simple = {}
    for name in ("io_uring_setup", "io_uring_enter", "io_uring_register", "userfaultfd",
                 "setxattrat", "removexattrat", "file_setattr", "utime", "utimes", "futimesat",
                 "uselib", "clone3"):
        if name in nr:
            simple[nr[name]] = RET_ERRNO(errno.ENOSYS)
    # Sessions, keyrings and namespaces stay the launcher's; Landlock does not cover keyrings.
    for name in ("setsid", "keyctl", "add_key", "request_key", "setns"):
        simple[nr[name]] = RET_ERRNO(errno.EPERM)
    for name in ("chmod", "fchmod", "fchmodat", "fchmodat2", "chown", "fchown", "lchown",
                 "fchownat", "utimensat", "setxattr", "lsetxattr", "fsetxattr", "removexattr",
                 "lremovexattr", "fremovexattr", "connect", "listen"):
        if name in nr:
            simple[nr[name]] = notify
    if network_mediated:
        simple[nr["bind"]] = notify
    for number in simple:
        p.jeq(number, "r%d" % number)
    p.jeq(nr["ioctl"], "ioctl")
    p.jeq(nr["socket"], "socket")
    p.jeq(nr["socketpair"], "socketpair")
    p.jeq(nr["unshare"], "namespaces")
    p.jeq(nr["clone"], "namespaces")
    if network_mediated:
        p.jeq(nr["sendto"], "fastopen3")
        p.jeq(nr["sendmmsg"], "fastopen3")
        p.jeq(nr["sendmsg"], "fastopen2")
    p.ret(RET_ALLOW)
    for number, action in simple.items():
        p.label("r%d" % number)
        p.ret(action)
    p.label("enosys")
    p.ret(RET_ERRNO(errno.ENOSYS))
    p.label("ioctl")
    p.ld_arg(1)
    for request in DENIED_IOCTLS:
        p.jeq(request, "eperm")
    p.ret(RET_ALLOW)
    p.label("namespaces")
    p.ld_arg(0)
    p.jset(NAMESPACE_FLAGS, "eperm")
    p.ret(RET_ALLOW)
    p.label("eperm")
    p.ret(RET_ERRNO(errno.EPERM))
    p.label("socket")
    p.ld_arg(0)
    p.jeq(AF_UNIX, "unix")
    p.jeq(AF_NETLINK, "netlink")
    p.jeq(AF_INET, "inet")
    p.jeq(AF_INET6, "inet")
    p.ret(RET_ERRNO(errno.EAFNOSUPPORT))
    p.label("netlink")
    p.ld_arg(2)
    p.jeq(0, "allow")  # NETLINK_ROUTE only: interface queries, no egress
    p.ret(RET_ERRNO(errno.EACCES))
    p.label("socketpair")
    # A datagram socketpair honours an explicit sendto() address: connection-oriented only.
    p.ld_arg(0)
    p.jeq(AF_UNIX, "pair_unix")
    p.ret(RET_ERRNO(errno.EACCES))
    p.label("pair_unix")
    p.ld_arg(1)
    p.alu_and(0xF)
    p.jeq(SOCK_STREAM, "allow")
    p.jeq(SOCK_SEQPACKET, "allow")
    p.ret(RET_ERRNO(errno.EACCES))
    p.label("unix")
    # Connection-oriented UNIX sockets only, created by the broker so it can mediate their
    # pathname connect/bind; datagram and raw (which the kernel maps to datagram) are refused.
    p.ld_arg(1)
    p.alu_and(0xF)
    p.jeq(SOCK_STREAM, "inet")
    p.jeq(SOCK_SEQPACKET, "inet")
    p.ret(RET_ERRNO(errno.EACCES))
    p.label("inet")
    p.ret(notify)
    if network_mediated:
        p.label("fastopen3")
        p.ld_arg(3)
        p.jset(MSG_FASTOPEN, "eacces")
        p.ret(RET_ALLOW)
        p.label("fastopen2")
        p.ld_arg(2)
        p.jset(MSG_FASTOPEN, "eacces")
        p.ret(RET_ALLOW)
        p.label("eacces")
        p.ret(RET_ERRNO(errno.EACCES))
    p.label("allow")
    p.ret(RET_ALLOW)
    return p.assemble()


def install_filter(table, program, listener):
    buffer = ctypes.create_string_buffer(program, len(program))
    fprog = struct.pack("HxxxxxxQ", len(program) // 8, ctypes.addressof(buffer))
    fprog_buffer = ctypes.create_string_buffer(fprog, len(fprog))
    flags = 8 if listener else 0  # SECCOMP_FILTER_FLAG_NEW_LISTENER
    return syscall(table["seccomp"], 1, flags, fprog_buffer)


# ---- roots and Landlock -------------------------------------------------------------------

def verify_roots(native, request):
    """Validates pinned descriptors against their recorded identity without reopening paths."""
    result = {"read": [], "write": []}
    seen = []
    for kind in ("read", "write"):
        for entry in request.get("roots", {}).get(kind, []):
            path, fd = entry.get("path"), entry.get("fd")
            if not isinstance(path, str) or type(fd) is not int or not native.valid_path(path) \
                    or os.path.normpath(path) != path:
                raise Refused("INVALID_REQUEST", "Supply canonical roots with pinned descriptors")
            try:
                info = os.fstat(fd)
                where = os.readlink("/proc/self/fd/%d" % fd)
            except OSError:
                raise Refused("ROOT_CHANGED", "A pinned root descriptor is not available")
            identity = [entry.get("dev"), entry.get("ino")]
            if not stat.S_ISDIR(info.st_mode) or identity != [info.st_dev, info.st_ino] \
                    or where != path:
                raise Refused("ROOT_CHANGED", "A pinned root no longer names its recorded object")
            os.set_inheritable(fd, False)
            result[kind].append({"path": path, "fd": fd})
            seen.append({"kind": kind, "path": path, "fd": fd, "dev": info.st_dev,
                         "ino": info.st_ino})
    if not result["write"]:
        raise Refused("INVALID_REQUEST", "Restricted execution needs at least one write root")
    return result, seen


def landlock_ruleset(roots, system_roots, network_mediated):
    attr = struct.pack("QQQ", FS_ALL, NET_MEDIATED if network_mediated else 0, SCOPE_ALL)
    attr_buffer = ctypes.create_string_buffer(attr, len(attr))
    ruleset = syscall(NR_LANDLOCK_CREATE, attr_buffer, len(attr), 0)
    os.set_inheritable(ruleset, False)

    def rule(fd, access):
        data = struct.pack("<Qi", access, fd)
        syscall(NR_LANDLOCK_ADD, ruleset, 1, ctypes.create_string_buffer(data, len(data)), 0)

    # The rules use the caller's pinned descriptors themselves.
    for root in roots["read"]:
        rule(root["fd"], FS_READ)
    for root in roots["write"]:
        rule(root["fd"], FS_ALL)
    opened = []
    try:
        for path in system_roots:
            try:
                fd = os.open(path, os.O_PATH | os.O_CLOEXEC)
            except FileNotFoundError:
                continue
            opened.append(fd)
            rule(fd, FS_READ if stat.S_ISDIR(os.fstat(fd).st_mode) else FS_READ & ~FS_READ_DIR)
        for path in DEVICE_FILES:
            try:
                fd = os.open(path, os.O_PATH | os.O_CLOEXEC)
            except OSError:
                continue
            opened.append(fd)
            if stat.S_ISCHR(os.fstat(fd).st_mode):
                rule(fd, FS_DEVICE)
    finally:
        for fd in opened:
            os.close(fd)
    return ruleset


# ---- broker -------------------------------------------------------------------------------

class Denied(Exception):
    pass


def socket_option(fd, level, name, size=4):
    value = ctypes.create_string_buffer(size)
    length = ctypes.c_uint32(size)
    if libc.getsockopt(fd, level, name, value, ctypes.byref(length)) < 0:
        code = ctypes.get_errno()
        raise OSError(code, os.strerror(code))
    return value.raw[:length.value]


def socket_domain(fd):
    return struct.unpack("i", socket_option(fd, SOL_SOCKET, SO_DOMAIN))[0]


def socket_name(fd):
    """The bound IP address of a broker-owned socket (0.0.0.0 / :: when unbound)."""
    buffer = ctypes.create_string_buffer(128)
    length = ctypes.c_uint32(128)
    if libc.getsockname(fd, buffer, ctypes.byref(length)) < 0:
        code = ctypes.get_errno()
        raise OSError(code, os.strerror(code))
    raw = buffer.raw[:length.value]
    family = struct.unpack("H", raw[:2])[0]
    if family == AF_INET:
        return str(ipaddress.ip_address(raw[4:8]))
    if family == AF_INET6:
        return str(ipaddress.ip_address(raw[8:24]))
    return None


class Broker:
    def __init__(self, native, roots, table, endpoints, listener):
        self.native = native
        self.files = native.NativeFiles(roots)
        self.names = {number: name for name, number in dict(table["nr"], **COMMON).items()}
        self.endpoints = endpoints
        self.listener = listener
        self.sockets = {}
        self.lock = threading.Lock()
        self.counts = {}

    # Target memory and descriptors are opened first and then checked with ID_VALID, so a
    # recycled PID can never be read in place of the notifying task.
    def valid(self, ident):
        value = ctypes.c_uint64(ident)
        try:
            ioctl(self.listener, NOTIF_ID_VALID, ctypes.byref(value))
            return True
        except OSError:
            return False

    def memory(self, pid, ident):
        fd = os.open("/proc/%d/mem" % pid, os.O_RDONLY | os.O_CLOEXEC)
        if not self.valid(ident):
            os.close(fd)
            raise OSError(errno.ESRCH, "Target exited")
        return fd

    @staticmethod
    def read(mem, address, size):
        try:
            data = os.pread(mem, size, address)
        except OSError:
            raise OSError(errno.EFAULT, "Bad address")
        if len(data) != size:
            raise OSError(errno.EFAULT, "Bad address")
        return data

    @staticmethod
    def string(mem, address, limit=4096):
        if address == 0:
            raise OSError(errno.EFAULT, "Bad address")
        out = bytearray()
        while len(out) < limit:
            chunk = 4096 - (address + len(out)) % 4096
            try:
                data = os.pread(mem, min(chunk, limit - len(out)), address + len(out))
            except OSError:
                raise OSError(errno.EFAULT, "Bad address")
            if not data:
                raise OSError(errno.EFAULT, "Bad address")
            end = data.find(b"\0")
            if end >= 0:
                return bytes(out + data[:end])
            out += data
        raise OSError(errno.ENAMETOOLONG, "Path too long")

    def target_link(self, pid, ident, name):
        value = os.readlink("/proc/%d/%s" % (pid, name))
        if not self.valid(ident):
            raise OSError(errno.ESRCH, "Target exited")
        return value

    # Every mutation is applied to an O_PATH descriptor resolved from the pinned write roots by
    # the native helper's own no-follow traversal, never to a string the target can change.
    def resolve(self, path, follow):
        if not path.startswith("/"):
            raise Denied()
        path = os.path.normpath(path)
        try:
            if follow:
                parent, name, _, _ = self.files.resolve(path, True, False, 0, True)
            else:
                head, name = os.path.split(path)
                if not name:
                    parent, name, _, _ = self.files.resolve(path, True, False, 0, True)
                else:
                    dparent, dname, _, _ = self.files.resolve(head, True, False, 0, True)
                    try:
                        parent = os.open(dname, os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW
                                         | os.O_CLOEXEC, dir_fd=dparent)
                    finally:
                        os.close(dparent)
        except self.native.ScopeDenied:
            raise Denied()
        except ValueError:
            raise Denied()
        try:
            return os.open(name, os.O_PATH | os.O_NOFOLLOW | os.O_CLOEXEC, dir_fd=parent)
        finally:
            os.close(parent)

    def in_scope(self, obj):
        where = os.readlink("/proc/self/fd/%d" % obj)
        if not where.startswith("/") or where.endswith(" (deleted)"):
            raise Denied()
        candidate = self.resolve(where, False)
        try:
            a, b = os.fstat(obj), os.fstat(candidate)
        finally:
            os.close(candidate)
        if (a.st_dev, a.st_ino) != (b.st_dev, b.st_ino):
            raise Denied()

    def object(self, pid, ident, mem, dirfd, address, flags, follow_default=True):
        dirfd = ctypes.c_int32(dirfd & 0xFFFFFFFF).value
        follow = follow_default and not (flags & AT_SYMLINK_NOFOLLOW)
        path = None if address == 0 else os.fsdecode(self.string(mem, address))
        if path is None or (path == "" and flags & AT_EMPTY_PATH):
            if dirfd == AT_FDCWD:
                link = "cwd"
            elif dirfd >= 0:
                link = "fd/%d" % dirfd
            else:
                raise OSError(errno.EBADF, "Bad descriptor")
            obj = os.open("/proc/%d/%s" % (pid, link), os.O_PATH | os.O_CLOEXEC)
            if not self.valid(ident):
                os.close(obj)
                raise OSError(errno.ESRCH, "Target exited")
            try:
                self.in_scope(obj)
            except BaseException:
                os.close(obj)
                raise
            return obj
        if path == "":
            raise OSError(errno.ENOENT, "Empty path")
        if not path.startswith("/"):
            if dirfd == AT_FDCWD:
                base = self.target_link(pid, ident, "cwd")
            elif dirfd >= 0:
                base = self.target_link(pid, ident, "fd/%d" % dirfd)
            else:
                raise OSError(errno.EBADF, "Bad descriptor")
            if not base.startswith("/") or base.endswith(" (deleted)"):
                raise Denied()
            path = base.rstrip("/") + "/" + path
        return self.resolve(path, follow)

    def apply_path(self, obj, op):
        return op("/proc/self/fd/%d" % obj)

    def handle(self, ident, pid, nr, args):
        name = self.names.get(nr)
        with self.lock:
            self.counts[name] = self.counts.get(name, 0) + 1
        mem = None
        try:
            if name == "socket":
                return self.socket(ident, args)
            if name == "listen":
                return self.listen(ident, pid, args)
            mem = self.memory(pid, ident)
            if name == "connect":
                return self.connect(ident, pid, mem, args)
            if name == "bind":
                return self.bind(ident, pid, mem, args)
            return self.metadata(ident, pid, mem, name, args)
        except Denied:
            return None, errno.EACCES
        except OSError as error:
            return None, error.errno or errno.EACCES
        finally:
            if mem is not None:
                os.close(mem)

    def metadata(self, ident, pid, mem, name, args):
        if name in ("chmod", "fchmodat", "fchmodat2", "fchmod"):
            if name == "chmod":
                dirfd, address, mode, flags = AT_FDCWD, args[0], args[1], 0
            elif name == "fchmod":
                dirfd, address, mode, flags = args[0], 0, args[1], AT_EMPTY_PATH
            else:
                dirfd, address, mode = args[0], args[1], args[2]
                flags = args[3] if name == "fchmodat2" else 0
            if flags & ~(AT_SYMLINK_NOFOLLOW | AT_EMPTY_PATH):
                return None, errno.EINVAL
            obj = self.object(pid, ident, mem, dirfd, address, flags)
            try:
                if stat.S_ISLNK(os.fstat(obj).st_mode):
                    return None, errno.EOPNOTSUPP
                self.apply_path(obj, lambda p: os.chmod(p, mode & 0o7777))
            finally:
                os.close(obj)
            return 0, 0
        if name in ("chown", "lchown", "fchownat", "fchown"):
            if name in ("chown", "lchown"):
                dirfd, address, owner, group = AT_FDCWD, args[0], args[1], args[2]
                flags = AT_SYMLINK_NOFOLLOW if name == "lchown" else 0
            elif name == "fchown":
                dirfd, address, owner, group, flags = args[0], 0, args[1], args[2], AT_EMPTY_PATH
            else:
                dirfd, address, owner, group, flags = args[:5]
                if flags & ~(AT_SYMLINK_NOFOLLOW | AT_EMPTY_PATH):
                    return None, errno.EINVAL
            obj = self.object(pid, ident, mem, dirfd, address, flags)
            try:
                if libc.fchownat(obj, b"", ctypes.c_uint32(owner & 0xFFFFFFFF),
                                 ctypes.c_uint32(group & 0xFFFFFFFF), AT_EMPTY_PATH) < 0:
                    return None, ctypes.get_errno()
            finally:
                os.close(obj)
            return 0, 0
        if name == "utimensat":
            dirfd, address, times, flags = args[0], args[1], args[2], args[3]
            if flags & ~(AT_SYMLINK_NOFOLLOW | AT_EMPTY_PATH):
                return None, errno.EINVAL
            value = None if times == 0 else self.read(mem, times, 32)
            obj = self.object(pid, ident, mem, dirfd, address, flags)
            try:
                if stat.S_ISLNK(os.fstat(obj).st_mode):
                    return None, errno.EOPNOTSUPP
                buffer = None if value is None else ctypes.create_string_buffer(value, 32)
                if libc.utimensat(AT_FDCWD, os.fsencode("/proc/self/fd/%d" % obj), buffer, 0) < 0:
                    return None, ctypes.get_errno()
            finally:
                os.close(obj)
            return 0, 0
        if name in ("setxattr", "lsetxattr", "fsetxattr", "removexattr", "lremovexattr",
                    "fremovexattr"):
            fd_based = name.startswith("f")
            nofollow = name.startswith("l")
            address = 0 if fd_based else args[0]
            dirfd = args[0] if fd_based else AT_FDCWD
            flags = AT_EMPTY_PATH if fd_based else (AT_SYMLINK_NOFOLLOW if nofollow else 0)
            attribute = self.string(mem, args[1], 256)
            if name.endswith("setxattr"):
                size = args[3]
                if size > 65536:
                    return None, errno.E2BIG
                value = self.read(mem, args[2], size) if size else b""
            obj = self.object(pid, ident, mem, dirfd, address, flags)
            try:
                if stat.S_ISLNK(os.fstat(obj).st_mode):
                    return None, errno.EPERM
                target = "/proc/self/fd/%d" % obj
                if name.endswith("setxattr"):
                    os.setxattr(target, attribute, value, args[4] & 0xFFFFFFFF)
                else:
                    os.removexattr(target, attribute)
            finally:
                os.close(obj)
            return 0, 0
        return None, errno.ENOSYS

    def socket(self, ident, args):
        domain = args[0] & 0xFFFFFFFF
        kind = args[1] & 0xFFFFFFFF
        protocol = args[2] & 0xFFFFFFFF
        base = kind & 0xF
        if kind & ~(0xF | SOCK_NONBLOCK | SOCK_CLOEXEC):
            return None, errno.EINVAL
        if domain == AF_UNIX:
            if base not in (SOCK_STREAM, SOCK_SEQPACKET) or protocol != 0:
                return None, errno.EACCES
        elif domain in (AF_INET, AF_INET6):
            if self.endpoints is not None and (
                    base != SOCK_STREAM or protocol not in (0, IPPROTO_TCP)):
                return None, errno.EACCES
        else:
            return None, errno.EAFNOSUPPORT
        # The broker creates and keeps the original socket so a later connect/bind is performed
        # on an object it owns, with an address it copied; the target receives an alias.
        fd = libc.socket(domain, base | (kind & SOCK_NONBLOCK), protocol)
        if fd < 0:
            return None, ctypes.get_errno()
        inode = os.fstat(fd).st_ino
        # Record ownership before the alias exists: the target may connect the moment ADDFD
        # completes its socket() call, possibly from another thread.
        with self.lock:
            self.sockets[inode] = fd
        data = struct.pack("QIIII", ident, ADDFD_SEND, fd, 0,
                           os.O_CLOEXEC if kind & SOCK_CLOEXEC else 0)
        buffer = ctypes.create_string_buffer(data, len(data))
        if libc.ioctl(self.listener, NOTIF_ADDFD, buffer) < 0:
            code = ctypes.get_errno()
            self.release(inode)
            return None, code
        return "sent", 0

    def owned(self, pid, ident, target_fd):
        link = self.target_link(pid, ident, "fd/%d" % (target_fd & 0xFFFFFFFF))
        if not link.startswith("socket:[") or not link.endswith("]"):
            return None, None
        inode = int(link[8:-1])
        with self.lock:
            return self.sockets.get(inode), inode

    def release(self, inode):
        with self.lock:
            fd = self.sockets.pop(inode, None)
        if fd is not None:
            os.close(fd)

    def unix_target(self, pid, ident, raw, create):
        """A pathname UNIX address resolved from the pinned write roots, as a /proc path."""
        name = raw[2:].split(b"\0", 1)[0]
        if len(raw) <= 2 or raw[2:3] == b"\0" or not name:
            raise Denied()  # abstract and unnamed addresses stay inside nobody's grant
        path = os.fsdecode(name)
        if not path.startswith("/"):
            base = self.target_link(pid, ident, "cwd")
            if not base.startswith("/") or base.endswith(" (deleted)"):
                raise Denied()
            path = base.rstrip("/") + "/" + path
        path = os.path.normpath(path)
        if not create:
            obj = self.resolve(path, True)
            if not stat.S_ISSOCK(os.fstat(obj).st_mode):
                os.close(obj)
                raise OSError(errno.ECONNREFUSED, "Not a socket")
            return obj, "/proc/self/fd/%d" % obj
        try:
            parent, final, _, _ = self.files.resolve(path, True, False, 0, False)
        except (self.native.ScopeDenied, ValueError):
            raise Denied()
        return parent, "/proc/self/fd/%d/%s" % (parent, final)

    @staticmethod
    def unix_address(path):
        encoded = os.fsencode(path)
        if len(encoded) >= 108:
            raise OSError(errno.ENAMETOOLONG, "Socket path too long")
        address = struct.pack("H", AF_UNIX) + encoded + b"\0"
        return ctypes.create_string_buffer(address, len(address)), len(address)

    def inet_address(self, raw, size):
        family = struct.unpack("H", raw[:2])[0]
        if family == AF_INET and size >= 16:
            return family, ipaddress.ip_address(raw[4:8]), struct.unpack(">H", raw[2:4])[0], 0
        if family == AF_INET6 and size >= 28:
            address = ipaddress.ip_address(raw[8:24])
            scope = struct.unpack("I", raw[24:28])[0]
            if address.ipv4_mapped:
                return family, address.ipv4_mapped, struct.unpack(">H", raw[2:4])[0], 0
            return family, address, struct.unpack(">H", raw[2:4])[0], scope
        return family, None, None, None

    def bind(self, ident, pid, mem, args):
        size = args[2] & 0xFFFFFFFF
        if size < 2 or size > 128:
            return None, errno.EINVAL
        raw = self.read(mem, args[1], size)
        own, inode = self.owned(pid, ident, args[0])
        if own is None:
            return None, errno.EACCES if inode is not None else errno.ENOTSOCK
        if socket_domain(own) == AF_UNIX:
            handle, target = self.unix_target(pid, ident, raw, True)
            try:
                buffer, length = self.unix_address(target)
                if libc.bind(own, buffer, ctypes.c_uint32(length)) < 0:
                    return None, ctypes.get_errno()
                return 0, 0
            finally:
                os.close(handle)
        _, address, _, _ = self.inet_address(raw, size)
        # Restricted none/allowlist listens on loopback only (product decision).
        if address is None or str(address) not in ("127.0.0.1", "::1"):
            return None, errno.EACCES
        copied = ctypes.create_string_buffer(raw, size)
        if libc.bind(own, copied, ctypes.c_uint32(size)) < 0:
            return None, ctypes.get_errno()
        return 0, 0

    def listen(self, ident, pid, args):
        own, inode = self.owned(pid, ident, args[0])
        if own is None:
            # Broker ownership ends only with a successful connect, so an unowned socket is
            # connected (or accepted, or a socketpair end): it cannot legitimately listen. Under
            # none/allowlist refuse it; never let listen() autobind an unowned TCP socket to every
            # interface. listen() carries no pointer, so CONTINUE is safe for environment.
            if self.endpoints is not None:
                return None, errno.EACCES
            return "continue", 0
        if self.endpoints is not None and socket_domain(own) != AF_UNIX:
            # An unbound TCP socket would autobind to every interface on listen().
            host = socket_name(own)
            if host not in ("127.0.0.1", "::1"):
                return None, errno.EACCES
        result = libc.listen(own, ctypes.c_int(args[1] & 0xFFFFFFFF))
        code = ctypes.get_errno() if result < 0 else 0
        # A listening socket never connects; drop the broker's reference so close semantics
        # remain the target's own.
        self.release(inode)
        return (None, code) if code else (0, 0)

    def connect(self, ident, pid, mem, args):
        size = args[2] & 0xFFFFFFFF
        if size < 2 or size > 128:
            return None, errno.EINVAL
        raw = self.read(mem, args[1], size)
        own, inode = self.owned(pid, ident, args[0])
        if own is None:
            return None, errno.EACCES if inode is not None else errno.ENOTSOCK
        if socket_domain(own) == AF_UNIX:
            handle, target = self.unix_target(pid, ident, raw, False)
            try:
                buffer, length = self.unix_address(target)
                result = libc.connect(own, buffer, ctypes.c_uint32(length))
                code = ctypes.get_errno() if result < 0 else 0
            finally:
                os.close(handle)
            if code == 0:
                self.release(inode)
            return (None, code) if code else (0, 0)
        family, address, port, scope = self.inet_address(raw, size)
        if family != AF_UNSPEC:  # AF_UNSPEC only dissolves an existing association
            if address is None:
                return None, errno.EACCES
            if self.endpoints is not None and (str(address), port, scope) not in self.endpoints:
                return None, errno.EACCES
        # Connect with the broker's own copy of the checked address on the broker-owned object.
        copied = ctypes.create_string_buffer(raw, size)
        if libc.connect(own, copied, ctypes.c_uint32(size)) < 0:
            code = ctypes.get_errno()
            if code == errno.EINPROGRESS:
                threading.Thread(target=self.settle, args=(own, inode), daemon=True).start()
            # A refused or dissolved association keeps the broker's ownership: an unconnected
            # unowned socket could otherwise listen() on every interface.
            return None, code
        if family != AF_UNSPEC:
            self.release(inode)
        return 0, 0

    def settle(self, fd, inode):
        poller = select.poll()
        poller.register(fd, select.POLLOUT)
        poller.poll()
        if struct.unpack("i", socket_option(fd, SOL_SOCKET, 4))[0] == 0:  # SO_ERROR
            self.release(inode)

    def respond(self, ident, value, code, flags=0):
        data = struct.pack("QqiI", ident, value or 0, -code if code else 0, flags)
        try:
            ioctl(self.listener, NOTIF_SEND, ctypes.create_string_buffer(data, len(data)))
        except OSError:
            pass

    def serve_one(self, ident, pid, nr, args):
        try:
            value, code = self.handle(ident, pid, nr, args)
        except Exception:
            value, code = None, errno.EACCES
        if value == "continue":
            self.respond(ident, 0, 0, 1)  # SECCOMP_USER_NOTIF_FLAG_CONTINUE
        elif value != "sent":
            self.respond(ident, value, code)

    def loop(self, stop):
        poller = select.poll()
        poller.register(self.listener, select.POLLIN)
        poller.register(stop, select.POLLIN)
        while True:
            events = dict(poller.poll())
            if stop in events:
                return
            event = events.get(self.listener, 0)
            if event & select.POLLIN:
                buffer = ctypes.create_string_buffer(80)
                if libc.ioctl(self.listener, NOTIF_RECV, buffer) < 0:
                    continue
                ident, pid, _, nr, _, _ = struct.unpack_from("QIIiIQ", buffer.raw)
                args = struct.unpack_from("6Q", buffer.raw, 32)
                threading.Thread(target=self.serve_one, args=(ident, pid, nr, args),
                                 daemon=True).start()
            elif event & (select.POLLHUP | select.POLLERR):
                return

    def close(self):
        with self.lock:
            fds = list(self.sockets.values())
            self.sockets.clear()
        for fd in fds:
            os.close(fd)


# ---- supervision --------------------------------------------------------------------------

def descendants():
    found = []
    pending = [os.getpid()]
    while pending:
        pid = pending.pop()
        try:
            tasks = os.listdir("/proc/%d/task" % pid)
        except OSError:
            continue
        for task in tasks:
            try:
                with open("/proc/%d/task/%s/children" % (pid, task)) as handle:
                    children = [int(value) for value in handle.read().split()]
            except OSError:
                continue
            for child in children:
                found.append((child, pid))
                pending.append(child)
    return found


def parent_of(pid):
    with open("/proc/%d/stat" % pid) as handle:
        data = handle.read()
    return int(data[data.rindex(")") + 2:].split()[1])


def kill_tree():
    """SIGKILLs every descendant by kernel parentage (the supervisor is their subreaper)."""
    killed = set()
    while True:
        tree = descendants()
        known = {os.getpid()} | {pid for pid, _ in tree}
        for pid, _ in tree:
            try:
                handle = syscall(NR_PIDFD_OPEN, pid, 0)
            except OSError:
                continue
            try:
                # The pidfd pins the process; confirm it is still inside our tree before signalling.
                if parent_of(pid) in known:
                    syscall(NR_PIDFD_SEND_SIGNAL, handle, signal.SIGKILL, None, 0)
                    killed.add(pid)
            except OSError:
                pass
            finally:
                os.close(handle)
        try:
            os.waitpid(-1, 0)
        except ChildProcessError:
            return len(killed)


class Report:
    def __init__(self, fd):
        self.fd = fd

    def write(self, event):
        if self.fd is None:
            return
        data = (json.dumps(event) + "\n").encode()
        while data:
            data = data[os.write(self.fd, data):]


def endpoints_of(network):
    kind = network.get("kind")
    if kind == "environment":
        return None
    if kind == "none":
        return set()
    if kind == "endpoints":
        allowed = set()
        for endpoint in network.get("endpoints", []):
            address = ipaddress.ip_address(endpoint["address"])
            port = endpoint["port"]
            scope = endpoint.get("scopeId", 0)
            if type(port) is not int or not 0 < port < 65536 or type(scope) is not int:
                raise Refused("INVALID_REQUEST", "Supply numeric endpoint ports and scope IDs")
            if address.version == 6 and address.ipv4_mapped:
                address, scope = address.ipv4_mapped, 0
            # A link-local IPv6 grant names one interface: the scope ID is part of the endpoint.
            allowed.add((str(address), port, scope if address.version == 6 else 0))
        return allowed
    raise Refused("INVALID_REQUEST", "Unknown network kind")


def restrict_child(table, ruleset, network_mediated, brokered, channel):
    """Runs in the forked child before exec: session, Landlock, seccomp, listener hand-off."""
    if libc.prctl(38, 1, 0, 0, 0) != 0:  # PR_SET_NO_NEW_PRIVS
        raise OSError(ctypes.get_errno(), "no_new_privs")
    syscall(NR_LANDLOCK_RESTRICT, ruleset, 0)
    listener = install_filter(table, build_filter(table, network_mediated, brokered), brokered)
    if brokered:
        socket.send_fds(channel, [b"L"], [listener])
        os.close(listener)


def close_except(keep):
    """close_range() over every descriptor from 3 up except the kept ones."""
    low = 3
    for fd in sorted(set(fd for fd in keep if fd >= 3)):
        if fd > low:
            syscall(NR_CLOSE_RANGE, low, fd - 1, 0)
        low = fd + 1
    syscall(NR_CLOSE_RANGE, low, 0xFFFFFFFF, 0)


class Cancellation:
    """SIGTERM/SIGINT handling installed (and the signals blocked) before any fork."""

    def __init__(self):
        self.signals = []
        self.wake_r, self.wake_w = os.pipe()
        os.set_blocking(self.wake_w, False)
        signal.signal(signal.SIGTERM, self.cancel)
        signal.signal(signal.SIGINT, self.cancel)

    def cancel(self, signum, _frame):
        self.signals.append(signum)
        try:
            os.write(self.wake_w, b"x")
        except OSError:
            pass


CANCEL_SIGNALS = {signal.SIGTERM, signal.SIGINT}


def start_time(pid):
    with open("/proc/%d/stat" % pid) as handle:
        data = handle.read()
    return int(data[data.rindex(")") + 2:].split()[19])


def reap(session):
    """Consumer-side cleanup after a lost supervisor: SIGKILL the launcher's closed session.

    The session ID is the restricted child's PID and setsid() is denied inside it, so membership
    is kernel-maintained and closed. Linux keeps a PID number reserved while it names a live
    session, so the session is ours while a process holding that PID still has the recorded start
    time, or no process holds it. Each member is pinned with a pidfd, then re-checked: still in the
    session, started no earlier than the leader, and the leader's PID not taken by another process
    since. A PID reuse within one scan can therefore only skip a process, never signal a stranger.
    """
    sid, started = int(session["sid"]), int(session["start"])
    killed = set()

    def leader_reused():
        try:
            return start_time(sid) != started
        except OSError:
            return False  # The leader exited; its PID stays reserved while members remain.

    while True:
        if leader_reused():
            return len(killed)
        members = []
        for entry in os.listdir("/proc"):
            if not entry.isdigit():
                continue
            try:
                with open("/proc/%s/stat" % entry) as handle:
                    data = handle.read()
            except OSError:
                continue
            fields = data[data.rindex(")") + 2:].split()
            # Zombies hold no grant and cannot be killed again; they only await their reaper.
            if int(fields[3]) == sid and fields[0] not in ("Z", "X"):
                members.append(int(entry))
        if not members:
            return len(killed)
        for pid in members:
            try:
                handle = syscall(NR_PIDFD_OPEN, pid, 0)
            except OSError:
                continue
            try:
                # The pidfd pins the process; confirm it still belongs to our session.
                with open("/proc/%d/stat" % pid) as stat_file:
                    data = stat_file.read()
                fields = data[data.rindex(")") + 2:].split()
                if int(fields[3]) == sid and int(fields[19]) >= started and not leader_reused():
                    syscall(NR_PIDFD_SEND_SIGNAL, handle, signal.SIGKILL, None, 0)
                    killed.add(pid)
            except OSError:
                pass
            finally:
                os.close(handle)
            # Wait for the signalled process to be gone (or a zombie) before rescanning.
            poller = select.poll()
            try:
                waiter = syscall(NR_PIDFD_OPEN, pid, 0)
            except OSError:
                continue
            try:
                poller.register(waiter, select.POLLIN)
                poller.poll()
            finally:
                os.close(waiter)


def run(request, report):
    machine, table = arch()
    native, native_path = load_native()
    status = probe_static(table, request.get("candidateArch") is True)
    if status:
        raise Refused("UNAVAILABLE", status)
    roots, seen = verify_roots(native, request)
    network = request.get("network", {"kind": "none"})
    endpoints = endpoints_of(network)
    network_mediated = endpoints is not None
    mode = request.get("mode")
    files = native.NativeFiles(roots)
    cwd_path = request.get("cwd") or roots["write"][0]["path"]
    try:
        cwd = files.open(cwd_path, directory=True)
    except (OSError, ValueError, native.ScopeDenied):
        raise Refused("SCOPE_DENIED", "The working directory is outside the pinned roots")
    os.set_inheritable(cwd, False)
    # The staged runtime directory (trusted, consumer-verified) stays readable for the helper.
    system_roots = list(request.get("systemRoots", DEFAULT_SYSTEM_ROOTS))
    system_roots.append(os.path.dirname(native_path))
    ruleset = landlock_ruleset(roots, system_roots, network_mediated or mode == "native")
    pinned_fds = [r["fd"] for r in roots["read"] + roots["write"]]
    launch = {"event": "launch", "arch": machine, "validated": machine in VALIDATED_ARCHES,
              "landlockAbi": landlock_abi(), "roots": seen,
              "ruleFds": [entry["fd"] for entry in seen], "brokerFds": pinned_fds,
              "nativeFds": pinned_fds if mode == "native" else [],
              "cwd": [os.fstat(cwd).st_dev, os.fstat(cwd).st_ino]}
    brokered = mode == "exec"
    parent_sock, child_sock = socket.socketpair()
    libc.prctl(36, 1, 0, 0, 0)  # PR_SET_CHILD_SUBREAPER
    native_in = None
    if mode == "native":
        native_in, native_out = os.pipe()
    elif mode != "exec":
        raise Refused("INVALID_REQUEST", "Unknown mode")
    parent = os.getpid()
    # Cancellation is armed before the fork: a SIGTERM during setup cancels instead of killing
    # the supervisor by default action and orphaning the child.
    cancellation = Cancellation()
    signal.pthread_sigmask(signal.SIG_BLOCK, CANCEL_SIGNALS)
    pid = os.fork()
    if pid == 0:
        try:
            libc.prctl(1, signal.SIGKILL, 0, 0, 0)  # PR_SET_PDEATHSIG
            if os.getppid() != parent:
                os._exit(125)
            os.setsid()
            signal.signal(signal.SIGTERM, signal.SIG_DFL)
            signal.signal(signal.SIGINT, signal.SIG_DFL)
            os.fchdir(cwd)
            parent_sock.close()
            if mode == "native":
                os.dup2(native_in, 0)
                keep = [r["fd"] for r in roots["read"] + roots["write"]]
            else:
                null = os.open("/dev/null", os.O_RDONLY)
                os.dup2(null, 0)
                keep = []
            restrict_child(table, ruleset, network_mediated or mode == "native", brokered,
                           child_sock)
            # No restricted code runs before the supervisor has recorded the session and holds
            # the listener: wait for its acknowledgement (EOF if it was lost).
            if child_sock.recv(1) != b"A":
                os._exit(125)
            child_sock.close()
            # Only stdio (and, for the native helper, the same pinned roots) survive exec.
            close_except(keep)
            for fd in keep:
                os.set_inheritable(fd, True)
            env = request.get("env") or {"PATH": "/usr/local/bin:/usr/bin:/bin"}
            if mode == "native":
                argv = [sys.executable, "-I", native_path]
            else:
                argv = request["argv"]
            signal.pthread_sigmask(signal.SIG_UNBLOCK, CANCEL_SIGNALS)
            os.execve(argv[0], argv, env)
        except BaseException as error:
            try:
                os.write(2, ("restricted launch failed: %s\n" % error).encode())
            finally:
                os._exit(126)
    # The consumer needs the closed session's identity before anything else can go wrong.
    try:
        report.write({"event": "session", "sid": pid, "start": start_time(pid)})
    finally:
        signal.pthread_sigmask(signal.SIG_UNBLOCK, CANCEL_SIGNALS)
    child_sock.close()
    os.close(ruleset)
    os.close(cwd)
    if native_in is not None:
        os.close(native_in)
        body = dict(request.get("native", {}))
        body["roots"] = roots
        data = json.dumps(body).encode()
        while data:
            data = data[os.write(native_out, data):]
        os.close(native_out)
    broker = None
    stop_r, stop_w = os.pipe()
    thread = None
    if brokered:
        message, fds, _, _ = socket.recv_fds(parent_sock, 1, 1)
        if not fds:
            kill_tree()
            raise Refused("UNAVAILABLE", "The restricted child did not hand over its listener")
        broker = Broker(native, roots, table, endpoints, fds[0])
        thread = threading.Thread(target=broker.loop, args=(stop_r,), daemon=True)
        thread.start()
    # Reported only once every restriction is installed and the broker holds the listener.
    report.write(launch)
    parent_sock.send(b"A")
    parent_sock.close()
    return supervise(pid, request, report, broker, thread, stop_w, cancellation)


def supervise(pid, request, report, broker, thread, stop_w, cancellation):
    wake_r = cancellation.wake_r
    cancelled = cancellation.signals
    handle = syscall(NR_PIDFD_OPEN, pid, 0)
    deadline = None
    if request.get("timeoutMs"):
        deadline = time.monotonic() + request["timeoutMs"] / 1000
    poller = select.poll()
    poller.register(handle, select.POLLIN)
    poller.register(wake_r, select.POLLIN)
    exit_code = None
    timed_out = False
    while True:
        timeout = None if deadline is None else max(0, int((deadline - time.monotonic()) * 1000))
        events = dict(poller.poll(timeout))
        if handle in events:
            _, status = os.waitpid(pid, 0)
            exit_code = os.waitstatus_to_exitcode(status)
            break
        if cancelled:
            break
        if deadline is not None and time.monotonic() >= deadline:
            timed_out = True
            break
    # Restricted descendants never outlive their supervisor: kill the remaining owned tree.
    survivors = kill_tree()
    os.write(stop_w, b"x")
    if thread is not None:
        thread.join()
    counts = {}
    if broker is not None:
        counts = dict(broker.counts)
        broker.close()
    report.write({"event": "exit", "exitCode": exit_code, "timedOut": timed_out,
                  "cancelled": bool(cancelled), "killed": survivors, "brokered": counts})
    if exit_code is None:
        return 124 if timed_out else 143
    return exit_code if exit_code >= 0 else 128 - exit_code


# ---- capability probe ---------------------------------------------------------------------

def probe_static(table, candidate=False):
    machine = platform.machine()
    if platform.system() != "Linux":
        return "Restricted Linux execution requires Linux"
    if table is None:
        return "No syscall inventory exists for %s" % machine
    if machine not in VALIDATED_ARCHES and not candidate:
        return "The syscall inventory is not validated on %s" % machine
    abi = landlock_abi()
    if abi < LANDLOCK_ABI_REQUIRED:
        return "Landlock ABI %d is below the required %d" % (abi, LANDLOCK_ABI_REQUIRED)
    if not os.path.exists("/proc/self/task/%d/children" % os.getpid()):
        return "The kernel does not expose child lists for exact supervision"
    return None


def probe(candidate=False):
    """Never raises: any failure is restricted unavailable with its reason.

    "restricted" is non-null only on a validated architecture. With candidate set on an
    unvalidated one, the primitives' result is reported separately under "candidate" (evidence
    collection only) and "restricted" stays null, so no consumer can read it as support.
    """
    machine = platform.machine()
    try:
        result = probe_primitives(candidate)
    except BaseException as error:
        return {"restricted": None, "arch": machine,
                "reason": "The probe failed: %s" % type(error).__name__}
    if candidate and machine not in VALIDATED_ARCHES:
        return {"restricted": None, "arch": machine, "validated": False,
                "reason": "The syscall inventory is not validated on %s" % machine,
                "candidate": result}
    return result


def probe_primitives(candidate):
    """Exercises the real primitives: Landlock, a seccomp listener, ADDFD and target memory."""
    machine, table = arch()
    reason = probe_static(table, candidate)
    if reason:
        return {"restricted": None, "reason": reason, "arch": machine}
    parent_sock, child_sock = socket.socketpair()
    pid = os.fork()
    if pid == 0:
        try:
            parent_sock.close()
            if libc.prctl(38, 1, 0, 0, 0) != 0:
                os._exit(3)
            attr = struct.pack("QQQ", FS_ALL, NET_CONNECT_TCP, SCOPE_ALL)
            ruleset = syscall(NR_LANDLOCK_CREATE, ctypes.create_string_buffer(attr, 24), 24, 0)
            syscall(NR_LANDLOCK_RESTRICT, ruleset, 0)
            listener = install_filter(table, build_filter(table, True, True), True)
            socket.send_fds(child_sock, [b"L"], [listener])
            os.close(listener)
            probe_socket = socket.socket(AF_INET, SOCK_STREAM)
            child_sock.send(b"ok" if probe_socket.fileno() >= 0 else b"no")
            os._exit(0)
        except BaseException:
            os._exit(4)
    child_sock.close()
    try:
        _, fds, _, _ = socket.recv_fds(parent_sock, 1, 1)
        if not fds:
            raise OSError(errno.EPERM, "The seccomp listener is not available")
        buffer = ctypes.create_string_buffer(80)
        ioctl(fds[0], NOTIF_RECV, buffer)
        ident, target, _, nr, _, _ = struct.unpack_from("QIIiIQ", buffer.raw)
        mem = os.open("/proc/%d/mem" % target, os.O_RDONLY)
        os.close(mem)
        own = socket.socket(AF_INET, SOCK_STREAM)
        data = struct.pack("QIIII", ident, ADDFD_SEND, own.fileno(), 0, 0)
        ioctl(fds[0], NOTIF_ADDFD, ctypes.create_string_buffer(data, len(data)))
        own.close()
        answer = parent_sock.recv(2)
        _, status = os.waitpid(pid, 0)
        if answer != b"ok" or os.waitstatus_to_exitcode(status) != 0:
            raise OSError(errno.EPERM, "The brokered socket did not reach the child")
        handle = syscall(NR_PIDFD_OPEN, os.getpid(), 0)
        os.close(handle)
    except OSError as error:
        try:
            os.kill(pid, signal.SIGKILL)
            os.waitpid(pid, 0)
        except OSError:
            pass
        return {"restricted": None, "arch": machine,
                "reason": "A required primitive failed: %s" % error.strerror}
    return {"restricted": {"filesystem": True, "network": True, "native": True,
                           "concurrentScopes": True},
            "arch": machine, "validated": machine in VALIDATED_ARCHES,
            "landlockAbi": landlock_abi()}


def main():
    report = Report(None)
    try:
        if len(sys.argv) > 1 and sys.argv[1] == "probe":
            print(json.dumps(probe("--candidate-arch" in sys.argv[2:])), flush=True)
            return 0
        if len(sys.argv) > 1 and sys.argv[1] == "reap":
            print(json.dumps({"killed": reap(json.load(sys.stdin))}), flush=True)
            return 0
        request = json.load(sys.stdin)
        report = Report(request.get("reportFd"))
        if report.fd is not None:
            os.set_inheritable(report.fd, False)
        return run(request, report)
    except Refused as error:
        report.write({"event": "refused", "code": error.code, "message": str(error)})
        return 125
    except Exception as error:
        report.write({"event": "refused", "code": "INVALID_REQUEST",
                      "message": "Restricted launch failed: %s" % type(error).__name__})
        return 125


if __name__ == "__main__":
    sys.exit(main())
