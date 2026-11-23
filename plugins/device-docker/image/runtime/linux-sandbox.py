import ctypes
import sys


def protect_self():
    """Makes this process (launcher, supervisor and broker thread) non-dumpable, first thing.

    execve resets dumpability, and without Yama a same-uid process (another session's Full work)
    could otherwise ptrace the launcher or open its /proc/<pid>/mem, environ and fd. Non-dumpable,
    those need CAP_SYS_PTRACE; fork inherits it, so the pre-exec child is covered until its own
    execve. Only a tracer still attached at this point is detected (and refused); see the
    documented exec-to-prctl window below for what is not.
    """
    if not sys.platform.startswith("linux"):
        return None
    if ctypes.CDLL(None, use_errno=True).prctl(4, 0, 0, 0, 0) != 0:  # PR_SET_DUMPABLE 0
        return "The launcher could not make itself non-dumpable"
    try:
        with open("/proc/self/status") as handle:
            for line in handle:
                if line.startswith("TracerPid:") and int(line.split()[1]) != 0:
                    return "The launcher was traced before it became non-dumpable"
    except (OSError, ValueError):
        return "The launcher could not confirm that it is not traced"
    return None


SELF_PROTECTION = protect_self()

import contextlib
import errno
import fcntl
import importlib.machinery
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
#   connections go only to the endpoints the consumer granted. A command's own loopback listener
#   is reachable from outside the sandbox, never from the command's own client: the broker cannot
#   tell an own listener from another process's at the address dialled (a listener can be
#   re-listened after another socket took its port, or share it through SO_REUSEPORT).
#   SO_REUSEPORT and its group programs (SO_ATTACH_REUSEPORT_CBPF / EBPF) are refused (EPERM), and
#   a socket with SO_REUSEPORT set never binds or listens: joining a foreign service's reuseport
#   group would receive that service's connections. Environment lifts that filter.
# - UNIX sockets in every network kind: stream/seqpacket only (datagram and raw are refused);
#   a pathname bind only inside the write roots, resolved through the pinned descriptors, and a
#   pathname connect only to a socket this operation bound itself (its dev and inode recorded at
#   the brokered bind), never to one another process made, even inside a write root (a user
#   D-Bus, a rootless docker.sock, ssh-agent, tmux); abstract and unnamed addresses are refused.
#   socketpair() is unaffected.
# - The launcher makes itself non-dumpable before anything else (protect_self), so a same-uid
#   process outside the operation cannot ptrace it or read its mem, environ or fd afterwards.
#   The window between the interpreter's exec and that first statement remains: only a tracer
#   still attached when protect_self runs is detected (the launcher then refuses). Anything done
#   or opened in the window is not detected: a /proc/<pid>/mem descriptor (read or write) keeps
#   working, and writes through it, process_vm_writev or pidfd_getfd made then leave no trace.
#   Closing the window needs a separate uid for Full work, or a non-dumpable zygote that the
#   consumer starts once and that forks a fresh launcher per operation (no exec in between).
# - The restricted command and the native helper are dumpable again after their own execve: the
#   broker must read the command's memory. Their memory and /proc/<pid>/environ stay readable,
#   and they stay ptraceable, by same-uid Full work on the device; consumers must not pass
#   per-session secrets through the command's environment or arguments. A consumer that signals
#   or inspects a launcher uses the pid and start time it recorded (the "session" event, its own
#   child), never a process found by an environment marker, which any same-uid process can copy.
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
            "setsockopt": 208,
            "sendmsg": 211, "add_key": 217, "request_key": 218, "keyctl": 219, "clone": 220,
            "setns": 268, "sendmmsg": 269, "userfaultfd": 282,
            "mknodat": 33, "mkdirat": 34, "unlinkat": 35, "symlinkat": 36, "linkat": 37,
            "renameat": 38, "truncate": 45, "openat": 56, "renameat2": 276,
        },
    },
    "x86_64": {
        "audit": 0xC000003E,
        "seccomp": 317,
        "x32": True,
        "nr": {
            "ioctl": 16, "socket": 41, "connect": 42, "sendto": 44, "sendmsg": 46, "bind": 49,
            "listen": 50, "socketpair": 53, "setsockopt": 54, "clone": 56, "chmod": 90, "fchmod": 91, "chown": 92, "fchown": 93,
            "lchown": 94, "setsid": 112, "utime": 132, "uselib": 134, "setxattr": 188,
            "lsetxattr": 189, "fsetxattr": 190, "removexattr": 197, "lremovexattr": 198,
            "fremovexattr": 199, "utimes": 235, "add_key": 248, "request_key": 249,
            "keyctl": 250, "fchownat": 260, "futimesat": 261, "fchmodat": 268, "unshare": 272,
            "utimensat": 280, "sendmmsg": 307, "setns": 308, "userfaultfd": 323,
            "open": 2, "truncate": 76, "rename": 82, "mkdir": 83, "rmdir": 84, "creat": 85,
            "link": 86, "unlink": 87, "symlink": 88, "mknod": 133, "openat": 257, "mkdirat": 258,
            "mknodat": 259, "unlinkat": 263, "renameat": 264, "linkat": 265, "symlinkat": 266,
            "renameat2": 316,
        },
    },
}
COMMON = {"io_uring_setup": 425, "io_uring_enter": 426, "io_uring_register": 427,
          "clone3": 435, "openat2": 437, "fchmodat2": 452, "setxattrat": 463, "removexattrat": 466,
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
# O_WRONLY | O_RDWR | O_CREAT | O_TRUNC | __O_TMPFILE (generic values on both architectures)
WRITE_OPEN_FLAGS = 0o20001103
O_TMPFILE_BIT = 0o20000000
AT_REMOVEDIR, AT_SYMLINK_FOLLOW = 0x200, 0x400
RENAME_NOREPLACE, RENAME_EXCHANGE = 1, 2
FILE_OPS = ("open", "openat", "creat", "mkdir", "mkdirat", "mknod", "mknodat", "rmdir", "unlink",
            "unlinkat", "symlink", "symlinkat", "link", "linkat", "rename", "renameat",
            "renameat2", "truncate")
STD_STREAMS = {"/dev/stdin": 0, "/dev/stdout": 1, "/dev/stderr": 2}


# The write policy shared with every consumer (sandbox-write-denies.ts): write_denied(path) and
# move_denied(source, destination, is_dir).

import unicodedata as _unicodedata
WRITE_DENIES = [[_unicodedata.normalize("NFKC", n).casefold() for n in e] for e in [[".gitconfig"],[".gitmodules"],[".bashrc"],[".bash_profile"],[".zshrc"],[".zprofile"],[".profile"],[".ripgreprc"],[".mcp.json"],[".envrc"],[".npmrc"],[".vscode"],[".idea"],[".claude","commands"],[".claude","agents"],[".husky"],[".huskyrc"],[".huskyrc.json"],[".huskyrc.js"],["husky.config.js"],[".pre-commit-config.yaml"],[".pre-commit-config.yml"],["lefthook.yml"],["lefthook.yaml"],["lefthook.json"],["lefthook.toml"],[".lefthook.yml"],[".lefthook.yaml"],[".lefthook.json"],[".lefthook.toml"],["lefthook-local.yml"],["lefthook-local.yaml"],["lefthook-local.json"],["lefthook-local.toml"],[".lefthook-local.yml"],[".lefthook-local.yaml"],[".lefthook-local.json"],[".lefthook-local.toml"],[".lefthook"],[".lefthook-local"],[".config","lefthook.yml"],[".config","lefthook.yaml"],[".config","lefthook.json"],[".config","lefthook.toml"],[".overcommit.yml"],[".simple-git-hooks.json"],[".simple-git-hooks.js"],[".simple-git-hooks.cjs"],["simple-git-hooks.json"],["simple-git-hooks.js"],["simple-git-hooks.cjs"],[".githooks"],[".zshenv"],[".zlogin"],[".zlogout"],[".bash_login"],[".bash_logout"],[".logout"],[".tcshrc"],[".cshrc"],[".kshrc"],[".config","git","config"],[".config","fish","config.fish"],[".config","fish","conf.d"],["library","launchagents"],["library","launchdaemons"],[".config","systemd"],[".local","share","systemd"],[".config","environment.d"],[".config","autostart"],[".config","autostart-scripts"],[".config","plasma-workspace","env"],[".xprofile"],[".xsessionrc"],[".local","bin"],[".cargo","bin"]]]
SYSTEM_WRITE_DENIES = [[_unicodedata.normalize("NFKC", n).casefold() for n in p.split("/") if n] for p in ["/var/spool/cron","/var/spool/at","/private/var/at/tabs","/private/var/at/jobs","/var/at"]]
PREFIX_GUARDED = [(e, False) for e in WRITE_DENIES if len(e) > 1] + [(e, True) for e in SYSTEM_WRITE_DENIES]
GIT_ALLOWED_DIRECTORIES = set(["objects","refs","logs","rebase-merge","rebase-apply","sequencer"])
GIT_ALLOWED_FILES = set(["index","head","orig_head","fetch_head","merge_head","merge_msg","merge_mode","merge_rr","auto_merge","cherry_pick_head","revert_head","rebase_head","bisect_log","bisect_start","bisect_expected_rev","bisect_ancestors_ok","bisect_names","bisect_terms","packed-refs","packed-refs.new","merge_autostash","commit_editmsg","tag_editmsg","squash_msg","shallow","description","gc.pid","gc.log","info","modules","worktrees"])
GIT_DANGER = set(["config","config.worktree","commondir","gitdir","hooks","info"])
PROTECTED_PATH_NAMES = set([".git",".gitconfig",".gitmodules",".bashrc",".bash_profile",".zshrc",".zprofile",".profile",".ripgreprc",".mcp.json",".envrc",".npmrc",".vscode",".idea",".husky",".huskyrc",".huskyrc.json",".huskyrc.js","husky.config.js",".pre-commit-config.yaml",".pre-commit-config.yml","lefthook.yml","lefthook.yaml","lefthook.json","lefthook.toml",".lefthook.yml",".lefthook.yaml",".lefthook.json",".lefthook.toml","lefthook-local.yml","lefthook-local.yaml","lefthook-local.json","lefthook-local.toml",".lefthook-local.yml",".lefthook-local.yaml",".lefthook-local.json",".lefthook-local.toml",".lefthook",".lefthook-local",".overcommit.yml",".simple-git-hooks.json",".simple-git-hooks.js",".simple-git-hooks.cjs","simple-git-hooks.json","simple-git-hooks.js","simple-git-hooks.cjs",".githooks",".zshenv",".zlogin",".zlogout",".bash_login",".bash_logout",".logout",".tcshrc",".cshrc",".kshrc",".xprofile",".xsessionrc"])
RESERVED_NAME_PREFIX = ".capybara-staging-"


def _fold_parts(path):
    return [_unicodedata.normalize("NFKC", p).casefold() for p in path.split("/") if p]


def _holds_head(head, prefix):
    if head == "logs":
        return not prefix or (len(prefix) == 3 and prefix[0] == "refs" and prefix[1] == "remotes")
    if head == "refs":
        return len(prefix) == 2 and prefix[0] == "remotes"
    return head == "sequencer" and not prefix


def _subtree_allowed(head, rest):
    for k, name in enumerate(rest):
        if name == ".git":
            return False
        if name == "head" and not (k == len(rest) - 1 and _holds_head(head, rest[:k])):
            return False
        if name in ("objects", "commondir", "gitdir") and _holds_head(head, rest[:k]):
            return False
    return True


def _git_internal_allowed(rel):
    if not rel:
        return True
    head = rel[0]
    if head in GIT_ALLOWED_DIRECTORIES:
        return _subtree_allowed(head, rel[1:])
    if head in ("modules", "worktrees") and len(rel) > 1:
        rest = rel[1:]
        if head == "worktrees":
            return _git_internal_allowed(rest[1:])
        readings = [rest[k + 1:] for k in range(len(rest))]
        if any(r and r[0] in GIT_DANGER and not _git_internal_allowed(r) for r in readings):
            return False
        return any(r and _git_internal_allowed(r) for r in readings)
    if len(rel) == 1:
        base = head[:-5] if head.endswith(".lock") else head
        stash = base.startswith("index.stash.") and base[12:].isascii() and base[12:].isdigit()
        return base in GIT_ALLOWED_FILES or stash
    return head == "info" and len(rel) == 2 and rel[1] in ("exclude", "exclude.lock")


def write_denied(path):
    names = _fold_parts(path)
    if any(n.startswith(RESERVED_NAME_PREFIX) for n in names):
        return True
    for system in SYSTEM_WRITE_DENIES:
        if names[:len(system)] == system:
            return True
    for entry in WRITE_DENIES:
        for i in range(len(names) - len(entry) + 1):
            if names[i:i + len(entry)] == entry:
                return True
    if ".git" in names:
        return not _git_internal_allowed(names[names.index(".git") + 1:])
    return bool(names) and names[-1] == "head"


def _prefix_next(dst):
    nxt = []
    for names, anchored in PREFIX_GUARDED:
        for k in range(1, len(names)):
            if (anchored and len(dst) != k) or len(dst) < k:
                continue
            if dst[len(dst) - k:] == names[:k]:
                nxt.append(names[k])
    return nxt


def move_denied(source, destination, is_dir, entries=None):
    if write_denied(source) or write_denied(destination):
        return True
    src, dst = _fold_parts(source), _fold_parts(destination)
    # an anchored deny's ancestor never moves away: a link resolved into it would dangle
    for names, anchored in PREFIX_GUARDED:
        if anchored and len(src) < len(names) and names[:len(src)] == src:
            return True
    nxt = _prefix_next(dst)
    if nxt:
        if not is_dir:
            return True
        if entries is None:
            # no entries given: list the source path itself, refusing what cannot be listed
            try:
                import os as _os
                entries = _os.listdir(source)
            except OSError:
                return True
        if any(_unicodedata.normalize("NFKC", n).casefold() in nxt for n in entries):
            return True

    def protected_at(names):
        return next((k for k, n in enumerate(names) if n in PROTECTED_PATH_NAMES), -1)

    def same_prefix(n):
        return n >= 0 and len(dst) > n + 1 and dst[:n + 1] == src[:n + 1]
    i = protected_at(src)
    if i >= 0 and not same_prefix(i):
        return True
    j = protected_at(dst)
    if is_dir and j >= 0 and not (i == j and same_prefix(j)):
        return True
    return (not is_dir) and bool(dst) and dst[-1] == ".git"

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
SO_REUSEPORT, SO_ATTACH_REUSEPORT_CBPF, SO_ATTACH_REUSEPORT_EBPF = 15, 51, 52
LOOPBACK = ("127.0.0.1", "::1")
# How long a guarded directory move waits for the device's other writes (a FIFO open waiting
# for its peer holds them) before it fails with EBUSY.
EXCLUSIVE_WAIT_S = 5
# The faultInjection seam's pause before a named mkdir, and the marker announcing it.
PAUSE_S = 2
PAUSE_MARKER = ".capybara-test-paused"
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


def load_native(fd=None):
    """The native helper beside this file, or (exec mode) from a sealed descriptor the consumer
    verified, so the bytes it checked are the bytes that run."""
    if fd is not None:
        if type(fd) is not int or fd < 3:
            raise Refused("INVALID_REQUEST", "Supply an inherited native helper descriptor")
        os.set_inheritable(fd, False)
        path = "/proc/self/fd/%d" % fd
    else:
        path = os.path.join(os.path.dirname(os.path.abspath(__file__)), "native-files.py")
    # an explicit source loader: a descriptor path has no .py suffix to infer one from
    spec = importlib.util.spec_from_loader(
        "capybara_native_files",
        importlib.machinery.SourceFileLoader("capybara_native_files", path))
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
    if network_mediated or brokered:
        # a pathname UNIX bind creates a file: the broker makes it (and checks the denies)
        simple[nr["bind"]] = notify
    if brokered:
        # Every filesystem write goes through the broker (Landlock grants the command read
        # access to its write roots only, so anything left unmediated fails closed).
        for name in FILE_OPS:
            if name in nr and name not in ("open", "openat"):
                simple[nr[name]] = RET_NOTIFY
        simple[nr["openat2"]] = RET_ERRNO(errno.ENOSYS)  # its flags sit behind a pointer
    for number in simple:
        p.jeq(number, "r%d" % number)
    if brokered:
        p.jeq(nr["openat"], "openat")
        if "open" in nr:
            p.jeq(nr["open"], "open")
    p.jeq(nr["ioctl"], "ioctl")
    p.jeq(nr["socket"], "socket")
    p.jeq(nr["socketpair"], "socketpair")
    p.jeq(nr["unshare"], "namespaces")
    p.jeq(nr["clone"], "namespaces")
    if network_mediated:
        p.jeq(nr["setsockopt"], "setsockopt")
        p.jeq(nr["sendto"], "fastopen3")
        p.jeq(nr["sendmmsg"], "fastopen3")
        p.jeq(nr["sendmsg"], "fastopen2")
    p.ret(RET_ALLOW)
    if network_mediated:
        # SO_REUSEPORT and its group programs: joining a foreign service's reuseport group would
        # receive that service's connections (kept close to the dispatch: jumps reach 255 at most)
        p.label("setsockopt")
        p.ld_arg(1)
        p.jeq(SOL_SOCKET, "sockopt_name")
        p.ret(RET_ALLOW)
        p.label("sockopt_name")
        p.ld_arg(2)
        for option in (SO_REUSEPORT, SO_ATTACH_REUSEPORT_CBPF, SO_ATTACH_REUSEPORT_EBPF):
            p.jeq(option, "sockopt_eperm")
        p.ret(RET_ALLOW)
        p.label("sockopt_eperm")
        p.ret(RET_ERRNO(errno.EPERM))
    for number, action in simple.items():
        p.label("r%d" % number)
        p.ret(action)
    p.label("enosys")
    p.ret(RET_ERRNO(errno.ENOSYS))
    if brokered:
        p.label("openat")
        p.ld_arg(2)
        p.jset(WRITE_OPEN_FLAGS, "notify")
        p.ret(RET_ALLOW)
        if "open" in nr:
            p.label("open")
            p.ld_arg(1)
            p.jset(WRITE_OPEN_FLAGS, "notify")
            p.ret(RET_ALLOW)
        p.label("notify")
        p.ret(RET_NOTIFY)
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
    """Validates pinned descriptors against their recorded identity without reopening paths.
    Read and write roots are directories; a file root (readFiles, exec mode only) is a regular
    file whose descriptor the consumer opened O_PATH | O_NOFOLLOW, so a symbolic link, directory,
    FIFO, socket or device given as a file root is refused here, as is a wrong recorded identity.
    A file root whose pinned file no longer sits at its path (renamed or deleted since the pin:
    editors and atomic saves do this) or has more than one name (a hard link could share a denied
    file's inode) is skipped: no rule, no refusal, the path stays unreadable."""
    result = {"read": [], "write": [], "readFiles": []}
    seen = []
    if request.get("roots", {}).get("readFiles") and request.get("mode") != "exec":
        raise Refused("INVALID_REQUEST", "File roots serve exec mode only")
    for kind in ("read", "write", "readFiles"):
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
            os.set_inheritable(fd, False)
            if kind == "readFiles":
                if not stat.S_ISREG(info.st_mode):
                    raise Refused("ROOT_CHANGED", "A pinned file root is not a regular file")
                if identity != [info.st_dev, info.st_ino]:
                    raise Refused("ROOT_CHANGED", "A pinned root no longer names its recorded object")
                if where != path or info.st_nlink != 1:
                    # renamed, deleted or given a second name since the pin: grant nothing for it
                    continue
            elif not stat.S_ISDIR(info.st_mode) or identity != [info.st_dev, info.st_ino] \
                    or where != path:
                raise Refused("ROOT_CHANGED", "A pinned root no longer names its recorded object")
            result[kind].append({"path": path, "fd": fd})
            seen.append({"kind": kind, "path": path, "fd": fd, "dev": info.st_dev,
                         "ino": info.st_ino})
    if not result["write"]:
        raise Refused("INVALID_REQUEST", "Restricted execution needs at least one write root")
    return result, seen


def landlock_ruleset(roots, system_roots, network_mediated, brokered_writes=False):
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
        # Brokered: the command reads its write roots; the broker performs every write.
        rule(root["fd"], FS_READ if brokered_writes else FS_ALL)
    for root in roots["readFiles"]:
        # The file's own inode, read only: no READ_DIR (a file has no listing to grant, and its
        # directory gets no rule from it) and no EXECUTE.
        rule(root["fd"], FS_READ_FILE)
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


def socket_address(fd):
    """The bound (IP address, port) of a broker-owned socket ((0.0.0.0 / ::, 0) when unbound)."""
    buffer = ctypes.create_string_buffer(128)
    length = ctypes.c_uint32(128)
    if libc.getsockname(fd, buffer, ctypes.byref(length)) < 0:
        code = ctypes.get_errno()
        raise OSError(code, os.strerror(code))
    raw = buffer.raw[:length.value]
    family = struct.unpack("H", raw[:2])[0]
    port = struct.unpack(">H", raw[2:4])[0]
    if family == AF_INET:
        return str(ipaddress.ip_address(raw[4:8])), port
    if family == AF_INET6:
        return str(ipaddress.ip_address(raw[8:24])), port
    return None, None


def socket_name(fd):
    """The bound IP address of a broker-owned socket (0.0.0.0 / :: when unbound)."""
    return socket_address(fd)[0]


def socket_int(fd, name):
    return struct.unpack("i", socket_option(fd, SOL_SOCKET, name))[0]


def add_write_denies(paths, *modules):
    """Absolute write denies the consumer resolved for this operation (a protected home location
    reached through a link, at its resolved target): denied with everything beneath them, and
    guarded against a prepared directory or a link moved onto a proper prefix, exactly like
    SYSTEM_WRITE_DENIES. Extends the policy of this process and of the given modules (one
    operation per launcher process)."""
    if not isinstance(paths, list) or not all(
            isinstance(p, str) and p.startswith("/") and os.path.normpath(p) == p for p in paths):
        raise Refused("INVALID_REQUEST", "Supply absolute normalized write denies")
    folded = [_fold_parts(p) for p in paths]
    for policy in (globals(),) + tuple(vars(m) for m in modules):
        if "SYSTEM_WRITE_DENIES" in policy and "PREFIX_GUARDED" in policy:
            policy["SYSTEM_WRITE_DENIES"].extend(folded)
            policy["PREFIX_GUARDED"].extend((names, True) for names in folded)


class SharedLock:
    """Many shared holders or one exclusive holder. New shared holders are not held back by a
    waiting exclusive one: a shared holder may wait long (a FIFO open waiting for its peer)."""

    def __init__(self):
        self.condition = threading.Condition()
        self.readers = 0
        self.writer = False

    @contextlib.contextmanager
    def shared(self):
        with self.condition:
            while self.writer:
                self.condition.wait()
            self.readers += 1
        try:
            yield
        finally:
            with self.condition:
                self.readers -= 1
                self.condition.notify_all()

    @contextlib.contextmanager
    def exclusive(self, timeout):
        """Raises EBUSY when the shared holders do not leave within timeout seconds."""
        deadline = time.monotonic() + timeout
        with self.condition:
            while self.writer or self.readers:
                left = deadline - time.monotonic()
                if left <= 0:
                    raise OSError(errno.EBUSY, "The operation's other writes did not finish")
                self.condition.wait(left)
            self.writer = True
        try:
            yield
        finally:
            with self.condition:
                self.writer = False
                self.condition.notify_all()


class NeedsExclusive(Exception):
    """A directory move into a guarded prefix: redone holding the files lock exclusively."""


class Broker:
    def __init__(self, native, roots, table, endpoints, listener, files_lock=None):
        self.native = native
        self.files = native.NativeFiles(roots)
        self.names = {number: name for name, number in dict(table["nr"], **COMMON).items()}
        self.endpoints = endpoints
        self.listener = listener
        self.sockets = {}
        # (st_dev, st_ino) of every pathname UNIX socket this operation bound through the broker:
        # the only sockets a pathname connect may reach. A socket another process made, even one
        # inside a write root (a user D-Bus, a rootless docker.sock, ssh-agent, tmux), stays
        # unreachable, as no sandboxed client connects to a foreign loopback listener either.
        self.unix_bound = set()
        self.lock = threading.Lock()
        # Every mutating file operation holds this shared; a directory move into a guarded prefix
        # holds it exclusively (staging, listing and the final rename). With the consumer's
        # "filesLockFd" it is the device's lock, so the exclusion spans every operation of the
        # device; without one it spans this operation only.
        self.files_lock = files_lock or SharedLock()
        # A failure the broker could not undo: the supervisor ends the operation and reports it.
        self.fatal = None
        # A test fixture's injected faults (request "faultInjection"); never set in production:
        # fault "fail" fails a staged move; pause_mkdir names a mkdir that, once checked, marks its
        # parent (PAUSE_MARKER) and waits PAUSE_S before its effect.
        self.fault = None
        self.pause_mkdir = None
        self.counts = {}
        # Creation modes are the command's (its umask is applied explicitly), never the broker's.
        os.umask(0)

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
        return self.rebase(value)

    def rebase(self, path):
        """A location the kernel reports (a cwd, a descriptor) in terms of the pinned roots'
        recorded paths: a root renamed during the operation keeps its grant, as in Landlock,
        and resolution continues from its pinned descriptor."""
        if not path.startswith("/"):
            return path
        best = None
        for root in self.files.roots["read"] + self.files.roots["write"]:
            try:
                now = os.readlink("/proc/self/fd/%d" % root["fd"])
            except OSError:
                continue
            if now == path or path.startswith(now.rstrip("/") + "/"):
                if best is None or len(now) > best[0]:
                    best = (len(now), root["path"].rstrip("/") + path[len(now.rstrip("/")):])
        return best[1] if best else path

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
        where = self.rebase(os.readlink("/proc/self/fd/%d" % obj))
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
        """The O_PATH object a metadata change applies to; a mandatory write deny is refused."""
        obj = self.object_unchecked(pid, ident, mem, dirfd, address, flags, follow_default)
        try:
            if write_denied(self.rebase(os.readlink("/proc/self/fd/%d" % obj))):
                raise Denied()
        except BaseException:
            os.close(obj)
            raise
        return obj

    def object_unchecked(self, pid, ident, mem, dirfd, address, flags, follow_default=True):
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
            try:
                with self.files_lock.shared():
                    if name in FILE_OPS:
                        return self.file_op(ident, pid, mem, name, args)
                    if name == "bind":
                        return self.bind(ident, pid, mem, args)
                    return self.metadata(ident, pid, mem, name, args)
            except NeedsExclusive:
                with self.files_lock.exclusive(EXCLUSIVE_WAIT_S):
                    return self.file_op(ident, pid, mem, name, args, exclusive=True)
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

    # ---- brokered filesystem writes ---------------------------------------------------------
    # The command's path is copied once; every step after that works on the broker's own
    # descriptors (pinned roots, no-follow traversal) and the deny check applies to the broker's
    # resolution, so nothing the command changes afterwards can redirect a write.

    def umask_of(self, pid, ident):
        with open("/proc/%d/status" % pid) as handle:
            text = handle.read()
        if not self.valid(ident):
            raise OSError(errno.ESRCH, "Target exited")
        for line in text.splitlines():
            if line.startswith("Umask:"):
                return int(line.split()[1], 8)
        return 0o022

    def path_arg(self, pid, ident, mem, dirfd, address):
        dirfd = ctypes.c_int32(dirfd & 0xFFFFFFFF).value
        path = os.fsdecode(self.string(mem, address))
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
        return path

    def entry(self, path):
        """(parent descriptor, final name, resolved path) of path's last component, unfollowed.
        The parent is resolved inside the pinned write roots, following in-scope links."""
        path = os.path.normpath(path)
        head, name = os.path.split(path)
        if not name or name in (".", ".."):
            raise OSError(errno.EBUSY, "Not an entry")
        try:
            dparent, dname, resolved, _ = self.files.resolve(head, True, False, 0, True)
            try:
                parent = os.open(dname, os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW
                                 | os.O_CLOEXEC, dir_fd=dparent)
            finally:
                os.close(dparent)
        except (self.native.ScopeDenied, ValueError):
            raise Denied()
        return parent, name, resolved.rstrip("/") + "/" + name

    def followed(self, path):
        """entry() after following final in-scope links (a dangling one names its target)."""
        parent, name, resolved = self.entry(path)
        for _ in range(40):
            try:
                info = os.stat(name, dir_fd=parent, follow_symlinks=False)
            except FileNotFoundError:
                return parent, name, resolved
            if not stat.S_ISLNK(info.st_mode):
                return parent, name, resolved
            target = os.readlink(name, dir_fd=parent)
            os.close(parent)
            parent, name, resolved = self.entry(
                os.path.join(os.path.dirname(resolved), target))
        os.close(parent)
        raise OSError(errno.ELOOP, "Too many links")

    @staticmethod
    def refuse(resolved, name, creates_entry=False):
        if write_denied(resolved):
            raise Denied()
        # a non-directory named .git is a gitdir pointer to configuration written elsewhere
        if creates_entry and _fold_parts(name) == [".git"]:
            raise Denied()

    # ---- post-effect verification ------------------------------------------------------------
    # A write is checked on the path its parent descriptor had, then applied through that
    # descriptor. The device's files lock keeps every sandboxed guarded move out of that window,
    # but a process outside the sandbox can still move the parent meanwhile. So after each
    # descriptor-relative create or rename the broker reads where the parent sits now and, when
    # the entry landed at a denied path, undoes the effect and refuses; an effect it cannot undo
    # ends the operation (fail).

    def placed(self, parent, name):
        """name below the parent descriptor, at the parent's current path (rebased onto the
        pinned roots' recorded paths); None when the parent is no longer reachable."""
        try:
            where = self.rebase(os.readlink("/proc/self/fd/%d" % parent))
        except OSError:
            return None
        if not where.startswith("/") or where.endswith(" (deleted)"):
            return None
        return where.rstrip("/") + "/" + name

    def verify(self, denied, undo, what):
        """Undoes an applied effect and refuses it when denied() says it landed somewhere denied
        (denied reads the entry's current place); an undo that fails ends the operation."""
        try:
            if not denied():
                return
        except Denied:
            pass
        try:
            undo()
        except OSError as error:
            self.fail("%s landed at a protected path after its check and could not be undone (%s)"
                      % (what, error.strerror))
        raise Denied()

    def created_denied(self, parent, name, creates_entry=False, link=False):
        """Whether the entry name below parent now sits at a path the write policy denies."""
        now = self.placed(parent, name)
        if now is None:
            return False
        if write_denied(now) or (creates_entry and _fold_parts(name) == [".git"]):
            return True
        return link and bool(_prefix_next(_fold_parts(now)))

    @staticmethod
    def remove_own(parent, name, ident, is_dir=False):
        """Removes the entry the broker just made (ident: its (st_dev, st_ino)), never another."""
        info = os.stat(name, dir_fd=parent, follow_symlinks=False)
        if (info.st_dev, info.st_ino) != ident:
            raise OSError(errno.ESTALE, "The created entry was replaced")
        if is_dir:
            os.rmdir(name, dir_fd=parent)
        else:
            os.unlink(name, dir_fd=parent)

    @staticmethod
    def identity(parent, name):
        info = os.stat(name, dir_fd=parent, follow_symlinks=False)
        return info.st_dev, info.st_ino

    def moved_denied(self, sparent, sname, dparent, dname, kinds):
        """Whether a rename, judged at its parents' current places, broke the write policy:
        kinds lists ((parent, name), is_dir) of each entry that moved, by its source."""
        source, destination = self.placed(sparent, sname), self.placed(dparent, dname)
        if source is None or destination is None:
            return False
        ends = {(sparent, sname): (source, destination), (dparent, dname): (destination, source)}
        for key, is_dir in kinds:
            origin, to = ends[key]
            # an unstaged directory landing at a guarded place was never listed there
            if move_denied(origin, to, is_dir) or (is_dir and _prefix_next(_fold_parts(to))):
                return True
        return write_denied(source) or write_denied(destination)

    @staticmethod
    def move_back(sparent, sname, dparent, dname, flags):
        """Reverses a rename: an exchange is exchanged again, a move moved back (never replacing)."""
        back = RENAME_EXCHANGE if flags & RENAME_EXCHANGE else RENAME_NOREPLACE
        if libc.renameat2(dparent, os.fsencode(dname), sparent, os.fsencode(sname),
                          ctypes.c_uint(back)) < 0:
            code = ctypes.get_errno()
            raise OSError(code, os.strerror(code))

    def staged_move(self, sparent, sname, dparent, dname, origin, to):
        """A directory move into a guarded place (a proper prefix of a multi-component deny). The
        directory is first renamed to a fresh reserved staging name beside it, which the write
        policy denies to every sandboxed write, so no process of this or another operation can add
        the guarded next component while it is listed and checked there; it is then renamed into
        place with NOREPLACE. A refused or failed step moves it back to its source; when that
        fails too (its name was taken meanwhile) it goes to a quarantine name, also reserved, and
        the operation ends with the failure reported."""
        fault = self.fault == "fail"
        stage = RESERVED_NAME_PREFIX + os.urandom(8).hex()
        if libc.renameat2(sparent, os.fsencode(sname), sparent, os.fsencode(stage),
                          ctypes.c_uint(RENAME_NOREPLACE)) < 0:
            return None, ctypes.get_errno()
        entries = self.listing(sparent, stage)
        if entries is None or move_denied(origin, to, True, entries):
            code = errno.EACCES
        elif fault:
            code = errno.EIO
        elif libc.renameat2(sparent, os.fsencode(stage), dparent, os.fsencode(dname),
                            ctypes.c_uint(RENAME_NOREPLACE)) == 0:
            def placed_denied():
                now = self.placed(dparent, dname)
                return now is not None and move_denied(origin, now, True,
                                                       self.listing(dparent, dname))
            self.verify(placed_denied,
                        lambda: self.move_back(sparent, sname, dparent, dname, 0), "A moved directory")
            return 0, 0
        else:
            code = ctypes.get_errno()
        if not fault and libc.renameat2(sparent, os.fsencode(stage), sparent, os.fsencode(sname),
                                        ctypes.c_uint(RENAME_NOREPLACE)) == 0:
            return None, code
        quarantine = RESERVED_NAME_PREFIX + "quarantine-" + os.urandom(8).hex()
        moved = libc.renameat2(sparent, os.fsencode(stage), sparent, os.fsencode(quarantine),
                               ctypes.c_uint(RENAME_NOREPLACE)) == 0
        try:
            where = self.rebase(os.readlink("/proc/self/fd/%d" % sparent))
        except OSError:
            where = os.path.dirname(origin)
        self.fail("A directory bound for %s could be moved neither into place nor back; it is in "
                  "quarantine as %s" % (to, os.path.join(where, quarantine if moved else stage)))
        return None, code

    @staticmethod
    def pause(parent):
        """The test seam's pause between a write's check and its effect, announced by a marker
        the broker creates in the parent it holds."""
        os.close(os.open(PAUSE_MARKER, os.O_WRONLY | os.O_CREAT | os.O_EXCL | os.O_CLOEXEC, 0o644,
                         dir_fd=parent))
        time.sleep(PAUSE_S)

    def fail(self, message):
        """Ends the operation for a failure the broker could not undo: the supervisor kills the
        whole tree (as for a cancel) and reports the message in its exit event."""
        if self.fatal is None:
            self.fatal = message
        os.kill(os.getpid(), signal.SIGTERM)

    @staticmethod
    def listing(parent, name):
        """The names in the directory name below parent, opened without following a link; None
        when it cannot be listed."""
        try:
            fd = os.open(name, os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW | os.O_CLOEXEC,
                         dir_fd=parent)
        except OSError:
            return None
        try:
            return os.listdir(fd)
        except OSError:
            return None
        finally:
            os.close(fd)

    def send_fd(self, ident, fd, cloexec):
        data = struct.pack("QIIII", ident, ADDFD_SEND, fd, 0, os.O_CLOEXEC if cloexec else 0)
        buffer = ctypes.create_string_buffer(data, len(data))
        if libc.ioctl(self.listener, NOTIF_ADDFD, buffer) < 0:
            return None, ctypes.get_errno()
        return "sent", 0

    def special_open(self, ident, pid, path, flags):
        """Device files and the command's own descriptors outside the roots, or None."""
        reopen = flags & ~(os.O_CREAT | os.O_EXCL | O_TMPFILE_BIT) | os.O_CLOEXEC
        if path == "/dev/tty":
            raise OSError(errno.ENXIO, "No controlling terminal")
        if path in DEVICE_FILES:
            fd = os.open(path, reopen | os.O_NOFOLLOW)
            if not stat.S_ISCHR(os.fstat(fd).st_mode):
                os.close(fd)
                raise Denied()
            return fd
        number = STD_STREAMS.get(path)
        parts = path.split("/")
        if number is None and len(parts) == 4 and parts[1] == "dev" and parts[2] == "fd":
            number = parts[3]
        elif (number is None and len(parts) == 5 and parts[1] == "proc" and parts[3] == "fd"
              and (parts[2] in ("self", "thread-self") or parts[2] == str(pid))):
            number = parts[4]
        if number is None:
            return None
        if not str(number).isdigit():
            raise OSError(errno.ENOENT, "No such descriptor")
        obj = os.open("/proc/%d/fd/%d" % (pid, int(number)), os.O_PATH | os.O_CLOEXEC)
        try:
            if not self.valid(ident):
                raise OSError(errno.ESRCH, "Target exited")
            mode = os.fstat(obj).st_mode
            if stat.S_ISFIFO(mode) or stat.S_ISSOCK(mode) or stat.S_ISCHR(mode):
                # The command's own pipe or terminal: reopening it widens nothing.
                return os.open("/proc/self/fd/%d" % obj, reopen)
            where = self.rebase(os.readlink("/proc/self/fd/%d" % obj))
        finally:
            os.close(obj)
        return where  # a file: resolved like any other path

    def open_entry(self, ident, parent, final, flags, mode):
        """Opens the resolved entry. A FIFO is opened without blocking this broker thread on a
        peer that may never come: it is retried while the notifying call is still waiting."""
        flags |= os.O_NOFOLLOW | os.O_CLOEXEC
        try:
            info = os.stat(final, dir_fd=parent, follow_symlinks=False)
        except FileNotFoundError:
            info = None
        if info is None or not stat.S_ISFIFO(info.st_mode) or flags & os.O_NONBLOCK:
            return os.open(final, flags, mode, dir_fd=parent)
        while True:
            try:
                fd = os.open(final, flags | os.O_NONBLOCK, mode, dir_fd=parent)
            except OSError as error:
                if error.errno != errno.ENXIO:
                    raise
                if not self.valid(ident):
                    raise OSError(errno.EINTR, "The call was abandoned")
                time.sleep(0.05)
                continue
            os.set_blocking(fd, True)
            return fd

    def file_op(self, ident, pid, mem, name, args, exclusive=False):
        if name in ("open", "openat", "creat"):
            if name == "open":
                dirfd, address, flags, mode = AT_FDCWD, args[0], args[1], args[2]
            elif name == "openat":
                dirfd, address, flags, mode = args[0], args[1], args[2], args[3]
            else:
                dirfd, address, mode = AT_FDCWD, args[0], args[1]
                flags = os.O_CREAT | os.O_WRONLY | os.O_TRUNC
            flags &= 0xFFFFFFFF
            path = self.path_arg(pid, ident, mem, dirfd, address)
            special = self.special_open(ident, pid, os.path.normpath(path), flags)
            if isinstance(special, int):
                try:
                    return self.send_fd(ident, special, flags & os.O_CLOEXEC)
                finally:
                    os.close(special)
            if isinstance(special, str):
                path = special
            umask = self.umask_of(pid, ident)
            exclusive = flags & os.O_CREAT and flags & os.O_EXCL
            if flags & O_TMPFILE_BIT or exclusive or flags & os.O_NOFOLLOW:
                parent, final, resolved = self.entry(path)
            else:
                parent, final, resolved = self.followed(path)
            tmpfile = flags & O_TMPFILE_BIT
            # truncation waits for the post-effect check (a read-only open truncates itself)
            truncate = flags & os.O_TRUNC and flags & os.O_ACCMODE != os.O_RDONLY
            try:
                self.refuse(resolved, final, not tmpfile)
                try:
                    before = os.stat(final, dir_fd=parent, follow_symlinks=False)
                except FileNotFoundError:
                    before = None
                fd = self.open_entry(ident, parent, final, flags & ~os.O_TRUNC if truncate
                                     else flags, mode & 0o7777 & ~umask)
                try:
                    if tmpfile:
                        # no name was made: the file vanishes with its descriptor
                        self.verify(lambda: self.created_denied(parent, final),
                                    lambda: None, "A temporary file")
                    else:
                        info = os.fstat(fd)
                        made = before is None and flags & os.O_CREAT
                        self.verify(
                            lambda: self.created_denied(parent, final, True),
                            (lambda: self.remove_own(parent, final, (info.st_dev, info.st_ino)))
                            if made else (lambda: None),
                            "A created file" if made else "An opened file")
                    if truncate and stat.S_ISREG(os.fstat(fd).st_mode):
                        os.ftruncate(fd, 0)
                except BaseException:
                    os.close(fd)
                    raise
            finally:
                os.close(parent)
            try:
                return self.send_fd(ident, fd, flags & os.O_CLOEXEC)
            finally:
                os.close(fd)
        if name in ("mkdir", "mkdirat", "mknod", "mknodat"):
            if name in ("mkdir", "mknod"):
                dirfd, address, rest = AT_FDCWD, args[0], args[1:]
            else:
                dirfd, address, rest = args[0], args[1], args[2:]
            mode = rest[0] & 0xFFFFFFFF
            umask = self.umask_of(pid, ident)
            parent, final, resolved = self.entry(self.path_arg(pid, ident, mem, dirfd, address))
            try:
                if name.startswith("mkdir"):
                    self.refuse(resolved, final)
                    if self.pause_mkdir is not None and final == self.pause_mkdir:
                        self.pause(parent)
                    os.mkdir(final, mode & 0o7777 & ~umask, dir_fd=parent)
                    made = self.identity(parent, final)
                    self.verify(lambda: self.created_denied(parent, final),
                                lambda: self.remove_own(parent, final, made, True), "A directory")
                else:
                    kind = stat.S_IFMT(mode) or stat.S_IFREG
                    if kind not in (stat.S_IFREG, stat.S_IFIFO, stat.S_IFSOCK):
                        return None, errno.EPERM
                    self.refuse(resolved, final, True)
                    os.mknod(final, kind | (mode & 0o7777 & ~umask), 0, dir_fd=parent)
                    made = self.identity(parent, final)
                    self.verify(lambda: self.created_denied(parent, final, True),
                                lambda: self.remove_own(parent, final, made), "A created node")
            finally:
                os.close(parent)
            return 0, 0
        if name in ("rmdir", "unlink", "unlinkat"):
            if name == "unlinkat":
                dirfd, address, flags = args[0], args[1], args[2]
                if flags & ~AT_REMOVEDIR:
                    return None, errno.EINVAL
            else:
                dirfd, address = AT_FDCWD, args[0]
                flags = AT_REMOVEDIR if name == "rmdir" else 0
            parent, final, resolved = self.entry(self.path_arg(pid, ident, mem, dirfd, address))
            try:
                self.refuse(resolved, final)
                if flags & AT_REMOVEDIR:
                    os.rmdir(final, dir_fd=parent)
                else:
                    os.unlink(final, dir_fd=parent)
            finally:
                os.close(parent)
            return 0, 0
        if name in ("symlink", "symlinkat"):
            target = os.fsdecode(self.string(mem, args[0]))
            if name == "symlink":
                dirfd, address = AT_FDCWD, args[1]
            else:
                dirfd, address = args[1], args[2]
            parent, final, resolved = self.entry(self.path_arg(pid, ident, mem, dirfd, address))
            try:
                self.refuse(resolved, final, True)
                # a link named for a proper prefix of a multi-component deny (.config, .claude)
                # would redirect the protected entry beneath it; move_denied refuses moving one
                # there too
                if _prefix_next(_fold_parts(resolved)):
                    raise Denied()
                os.symlink(target, final, dir_fd=parent)
                made = self.identity(parent, final)
                self.verify(lambda: self.created_denied(parent, final, True, link=True),
                            lambda: self.remove_own(parent, final, made), "A symbolic link")
            finally:
                os.close(parent)
            return 0, 0
        if name in ("link", "linkat"):
            if name == "link":
                odir, oaddr, ndir, naddr, flags = AT_FDCWD, args[0], AT_FDCWD, args[1], 0
            else:
                odir, oaddr, ndir, naddr, flags = args[:5]
            if flags & AT_EMPTY_PATH:
                return None, errno.ENOENT  # needs CAP_DAC_READ_SEARCH, which commands lack
            if flags & ~AT_SYMLINK_FOLLOW:
                return None, errno.EINVAL
            source = self.path_arg(pid, ident, mem, odir, oaddr)
            sparent, sname, sresolved = (self.followed(source) if flags & AT_SYMLINK_FOLLOW
                                         else self.entry(source))
            try:
                self.refuse(sresolved, sname)
                dparent, dname, dresolved = self.entry(
                    self.path_arg(pid, ident, mem, ndir, naddr))
                try:
                    self.refuse(dresolved, dname, True)
                    if move_denied(sresolved, dresolved, False):
                        raise Denied()
                    os.link(sname, dname, src_dir_fd=sparent, dst_dir_fd=dparent,
                            follow_symlinks=False)
                    made = self.identity(dparent, dname)

                    def linked_denied():
                        source_now = self.placed(sparent, sname)
                        target_now = self.placed(dparent, dname)
                        return self.created_denied(dparent, dname, True) or (
                            source_now is not None and target_now is not None
                            and move_denied(source_now, target_now, False))
                    self.verify(linked_denied, lambda: self.remove_own(dparent, dname, made),
                                "A hard link")
                finally:
                    os.close(dparent)
            finally:
                os.close(sparent)
            return 0, 0
        if name in ("rename", "renameat", "renameat2"):
            if name == "rename":
                odir, oaddr, ndir, naddr, flags = AT_FDCWD, args[0], AT_FDCWD, args[1], 0
            elif name == "renameat":
                odir, oaddr, ndir, naddr = args[:4]
                flags = 0
            else:
                odir, oaddr, ndir, naddr, flags = args[:5]
            flags &= 0xFFFFFFFF
            if flags & ~(RENAME_NOREPLACE | RENAME_EXCHANGE):
                return None, errno.EINVAL
            sparent, sname, sresolved = self.entry(self.path_arg(pid, ident, mem, odir, oaddr))
            try:
                dparent, dname, dresolved = self.entry(
                    self.path_arg(pid, ident, mem, ndir, naddr))
                try:
                    self.refuse(sresolved, sname)
                    self.refuse(dresolved, dname)
                    moves = [((sparent, sname), sresolved, dresolved)]
                    if flags & RENAME_EXCHANGE:
                        moves.append(((dparent, dname), dresolved, sresolved))
                    staged = None
                    kinds = []
                    for (parent, entry), origin, to in moves:
                        try:
                            info = os.stat(entry, dir_fd=parent, follow_symlinks=False)
                        except FileNotFoundError:
                            continue
                        is_dir = stat.S_ISDIR(info.st_mode)
                        kinds.append(((parent, entry), is_dir))
                        if is_dir and _prefix_next(_fold_parts(to)):
                            # a directory bound for a guarded place: checked in staging
                            if flags & RENAME_EXCHANGE:
                                raise Denied()
                            if not exclusive:
                                raise NeedsExclusive()
                            staged = (origin, to)
                            continue
                        # nothing leaves a protected name, nor is a directory moved under one
                        if move_denied(origin, to, is_dir):
                            raise Denied()
                    if staged is not None:
                        return self.staged_move(sparent, sname, dparent, dname, *staged)
                    if libc.renameat2(sparent, os.fsencode(sname), dparent, os.fsencode(dname),
                                      ctypes.c_uint(flags)) < 0:
                        return None, ctypes.get_errno()
                    self.verify(lambda: self.moved_denied(sparent, sname, dparent, dname, kinds),
                                lambda: self.move_back(sparent, sname, dparent, dname, flags),
                                "A move")
                finally:
                    os.close(dparent)
            finally:
                os.close(sparent)
            return 0, 0
        if name == "truncate":
            length = ctypes.c_int64(args[1]).value
            parent, final, resolved = self.followed(self.path_arg(pid, ident, mem, AT_FDCWD,
                                                                  args[0]))
            try:
                self.refuse(resolved, final)
                fd = os.open(final, os.O_WRONLY | os.O_NOFOLLOW | os.O_CLOEXEC, dir_fd=parent)
                try:
                    # checked again at the parent's current place before the effect
                    self.verify(lambda: self.created_denied(parent, final), lambda: None,
                                "A truncation")
                except BaseException:
                    os.close(fd)
                    raise
            finally:
                os.close(parent)
            try:
                os.ftruncate(fd, length)
            finally:
                os.close(fd)
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
            parent, final, resolved, _ = self.files.resolve(path, True, False, 0, False)
        except (self.native.ScopeDenied, ValueError):
            raise Denied()
        if write_denied(resolved):
            os.close(parent)
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
                # the socket file bind created, through the same pinned parent descriptor
                created = os.lstat(target)
                with self.lock:
                    self.unix_bound.add((created.st_dev, created.st_ino))
                return 0, 0
            finally:
                os.close(handle)
        _, address, _, _ = self.inet_address(raw, size)
        # Restricted none/allowlist listens on loopback only (product decision); environment
        # lifts only the network filter.
        if address is None or (self.endpoints is not None and str(address) not in LOOPBACK):
            return None, errno.EACCES
        if self.endpoints is not None and socket_int(own, SO_REUSEPORT):
            return None, errno.EPERM  # never into a foreign service's reuseport group
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
        if self.endpoints is not None and socket_domain(own) != AF_UNIX \
                and socket_int(own, SO_REUSEPORT):
            self.release(inode)
            return None, errno.EPERM  # never into a foreign service's reuseport group
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
                # only a socket this operation bound itself: the descriptor pins the inode, and
                # the connect goes through it, so a swapped path cannot change what is reached
                found = os.fstat(handle)
                with self.lock:
                    own_socket = (found.st_dev, found.st_ino) in self.unix_bound
                if not own_socket:
                    return None, errno.EACCES
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

    # Each notification is served on its own thread. That is sound because no handler keeps
    # shared mutable state across its steps (socket ownership is locked): every check is made on
    # the broker's own resolution, and every effect is one syscall on descriptors that handler
    # holds, so concurrent notifications interleave only as the kernel would interleave the calls.
    # The one multi-step check, a directory move into a guarded prefix (staging, listing, rename),
    # holds the files lock exclusively (waiting at most EXCLUSIVE_WAIT_S, then EBUSY) while every
    # other write holds it shared from its check to its effect. With the consumer's device lock
    # this spans every operation of the device: no write of another operation can be checked
    # against a parent that such a move relocates before the write's effect (its staging name is
    # reserved too, so no path-based write reaches it). Each create or rename is then verified at
    # its parent's current place (verify), which covers moves made outside every sandbox.
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


def device_files_lock(request, roots, system_roots):
    """The inherited descriptor of the device's files lock ("filesLockFd", exec mode), or None.

    It must be a regular file outside every root this command reads or writes (and every system
    root): the restricted command could otherwise open it and hold it, stalling the device's
    writes. The descriptor itself never reaches the command (close_except before exec)."""
    fd = request.get("filesLockFd")
    if fd is None:
        return None
    if request.get("mode") != "exec" or not isinstance(fd, int) or isinstance(fd, bool) or fd < 3:
        raise Refused("INVALID_REQUEST", "A files lock descriptor serves exec mode only")
    try:
        info = os.fstat(fd)
        where = os.readlink("/proc/self/fd/%d" % fd)
    except OSError:
        raise Refused("INVALID_REQUEST", "The files lock descriptor is not open")
    if not stat.S_ISREG(info.st_mode) or not where.startswith("/") or where.endswith(" (deleted)"):
        raise Refused("INVALID_REQUEST", "The files lock is not a regular file")
    granted = roots["read"] + roots["write"] + roots["readFiles"]
    reach = [r["path"] for r in granted] + list(system_roots)
    for entry in granted:
        try:
            reach.append(os.readlink("/proc/self/fd/%d" % entry["fd"]))
        except OSError:
            pass
    for root in reach:
        root = os.path.normpath(root)
        if root == "/" or where == root or where.startswith(root + "/"):
            raise Refused("SCOPE_DENIED", "The device's files lock is inside the granted root %s"
                          % root)
    os.set_inheritable(fd, False)
    return fd


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
    if request.get("nativeFd") is not None and request.get("mode") != "exec":
        raise Refused("INVALID_REQUEST", "A native helper descriptor serves exec mode only")
    native, native_path = load_native(request.get("nativeFd"))
    status = probe_static(table, request.get("candidateArch") is True)
    if status:
        raise Refused("UNAVAILABLE", status)
    roots, seen = verify_roots(native, request)
    add_write_denies(request.get("writeDenies", []), native)
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
    if request.get("nativeFd") is None:
        system_roots.append(os.path.dirname(native_path))
    files_lock = device_files_lock(request, roots, system_roots)
    ruleset = landlock_ruleset(roots, system_roots, network_mediated or mode == "native",
                               mode == "exec")
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
        # restricted native writes honour the mandatory write denies too
        body["roots"] = dict(roots, denyWrites=True)
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
        broker = Broker(native, roots, table, endpoints, fds[0],
                        native.DeviceFilesLock(files_lock) if files_lock is not None else None)
        fault = request.get("faultInjection")
        if isinstance(fault, dict) and fault.get("stagedMove") == "fail":
            broker.fault = "fail"  # a test fixture's seam
        if isinstance(fault, dict) and isinstance(fault.get("pauseBeforeMkdir"), str):
            broker.pause_mkdir = fault["pauseBeforeMkdir"]  # a test fixture's seam
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
    fatal = None
    if broker is not None:
        counts = dict(broker.counts)
        fatal = broker.fatal
        broker.close()
    event = {"event": "exit", "exitCode": exit_code, "timedOut": timed_out,
             "cancelled": bool(cancelled), "killed": survivors, "brokered": counts}
    if fatal is not None:
        event["fatal"] = fatal
    report.write(event)
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
    if SELF_PROTECTION:
        return SELF_PROTECTION
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
            # Dumpable like a real restricted child after its execve, so the broker's memory read
            # is exercised as in a launch (fork inherited non-dumpable; the probe holds no secret).
            if libc.prctl(4, 1, 0, 0, 0) != 0:  # PR_SET_DUMPABLE 1
                os._exit(3)
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
