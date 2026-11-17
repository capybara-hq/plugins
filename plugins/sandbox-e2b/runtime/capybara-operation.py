# Trusted in-VM consumer for the sandbox-e2b provider (staged by the provider as root,
# root-owned and hash-checked, in a directory named after this file's digest, next to the SDK's
# native-files.py and linux-sandbox.py). An adapted copy of sandbox-docker's agent: it never
# decides authority; every request carries the operation's immutable scope, already resolved by
# the kernel.
#
# Restricted execution is not part of this agent. The SDK launcher needs Landlock ABI 6, which
# the tested E2B template kernel does not have (Linux 6.1, Landlock ABI 2); the provider reports
# restricted support unavailable
# and refuses scoped grants before any effect. "probe" still runs the launcher's own probe so the
# report names the template's actual facts.
#
#   direct          native work without the launcher (Full access on "/", owner browsing of
#                   read roots, trusted preparation); descriptor-relative, no-follow traversal.
#   full            Full access exec: checks admission, then execs the provider's ordinary wrapper.
#   bg-*            Full access background executions: a detached supervisor per operation, with
#                   a root recorder owning an append-only output spool and a status record.
#   probe           the launcher's own probe, plus the template's kernel release.
#   consume/revoke  (root) the durable operation records, tombstones and cancellation markers in
#   cancel-mark     the root-owned record directory on the VM's persistent disk.
import base64
import ctypes
import errno
import hashlib
import hmac
import importlib.util
import json
import os
import re
import shutil
import signal
import socket
import stat
import struct
import subprocess
import sys
import threading
import time

RUNTIME = os.path.dirname(os.path.abspath(__file__))
LAUNCHER = os.path.join(RUNTIME, "linux-sandbox.py")
NATIVE = os.path.join(RUNTIME, "native-files.py")
# The record directory on the VM's disk (kept while the VM is paused without memory): created and
# written only by root (0711, records 0600; markers 0644 so the sandbox user can test for them).
OPS_ROOT = "/opt/capybara-e2b-ops"
OPS_VIEW = OPS_ROOT
# Paths reserved for the provider: its records, runtime, root staging area and control files.
PROTECTED = ("/tmp/.capybara-exec-", OPS_ROOT, "/opt/capybara", "/opt/capybara-e2b-runtime")
MARKER = "capybara-exec"
CHUNK = 65536
libc = ctypes.CDLL(None, use_errno=True)


class Refused(Exception):
    def __init__(self, code, message):
        super().__init__(message)
        self.code = code


# ---- framing (stdout is the provider's only channel) ---------------------------------------

out_lock = threading.Lock()


def frame(kind, data):
    with out_lock:
        sys.stdout.buffer.write(kind + len(data).to_bytes(4, "big") + data)
        sys.stdout.buffer.flush()


def finish(result):
    frame(b"R", json.dumps(result).encode())


def read_request():
    line = sys.stdin.buffer.readline()
    size = int(line)
    if size < 0 or size > 64 * 1024 * 1024:
        raise ValueError("request too large")
    data = bytearray()
    while len(data) < size:
        chunk = sys.stdin.buffer.read(size - len(data))
        if not chunk:
            raise ValueError("truncated request")
        data += chunk
    return json.loads(data)


def load(path, name):
    spec = importlib.util.spec_from_file_location(name, path)
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


# ---- admission: tombstones, deadlines and staged bytes --------------------------------------

def op_key(operation_id):
    return hashlib.sha256(operation_id.encode()).hexdigest()


def ops_dir():
    return OPS_ROOT if os.getuid() == 0 else OPS_VIEW


def admit(request):
    """Refuses a revoked operation, a passed admission deadline or a requested cancellation.
    Tombstones and cancellation markers are root-written; the sandbox user cannot forge them."""
    key = request.get("opKey")
    if key and os.path.exists(os.path.join(ops_dir(), key + ".revoked")):
        raise Refused("REVOKED", "The operation was revoked")
    deadline = request.get("admitBeforeMs")
    if deadline is not None and time.time() * 1000 > deadline:
        raise Refused("EXPIRED", "The operation's admission deadline passed")
    if key and os.path.exists(os.path.join(ops_dir(), key + ".cancelled")):
        raise Refused("CANCELLED", "The operation was cancelled before it started")


def protected(path, write):
    """A write root containing (or inside) the provider's records or control files, or a read
    root inside the records, is refused (defence in depth beside the root-owned records)."""
    path = os.path.normpath(path)
    for entry in PROTECTED:
        inside = path == entry.rstrip("-") or path.startswith(entry.rstrip("/") + "/")
        if write and (inside or entry.startswith(path.rstrip("/") + "/")):
            return True
        if not write and inside and entry != "/tmp/.capybara-exec-":
            return True
    return False


def verify_runtime(expected):
    """The staged SDK bytes must match the digests the provider was built against."""
    for name, digest in expected.items():
        path = os.path.join(RUNTIME, name)
        info = os.lstat(path)
        if not stat.S_ISREG(info.st_mode) or info.st_uid != 0 or info.st_mode & 0o022:
            raise Refused("UNAVAILABLE", "The staged runtime is not root-owned and read-only")
        with open(path, "rb") as handle:
            if hashlib.sha256(handle.read()).hexdigest() != digest:
                raise Refused("UNAVAILABLE", "The staged runtime does not match its digest")
    info = os.lstat(RUNTIME)
    if not stat.S_ISDIR(info.st_mode) or info.st_uid != 0 or info.st_mode & 0o022:
        raise Refused("UNAVAILABLE", "The runtime directory is writable by the operation user")


# ---- pinned roots -------------------------------------------------------------------------

def close_pinned(pinned):
    for entry in pinned:
        try:
            os.close(entry["fd"])
        except OSError:
            pass


def pin(paths, write=False):
    """Opens each existing granted root once (no-follow, canonical) and records its identity.

    A root that does not exist grants nothing and is left out; a root that is not a real
    directory at its canonical path (a swapped symlink, for example) refuses the operation."""
    pinned = []
    try:
        for path in paths:
            if protected(path, write):
                raise Refused("SCOPE_DENIED", "A granted root contains the provider's records")
            try:
                fd = os.open(path, os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW | os.O_CLOEXEC)
            except FileNotFoundError:
                continue
            except OSError:
                raise Refused("SCOPE_DENIED", "A granted root is not a directory at its path")
            info = os.fstat(fd)
            pinned.append({"path": path, "fd": fd, "dev": info.st_dev, "ino": info.st_ino})
            if os.readlink("/proc/self/fd/%d" % fd) != path:
                raise Refused("SCOPE_DENIED", "A granted root is not canonical")
    except BaseException:
        close_pinned(pinned)
        raise
    return pinned


def pin_under(base, relative, create):
    """Pins base/relative component by component without following links (trusted staging)."""
    fd = os.open(base, os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW | os.O_CLOEXEC)
    try:
        for name in [part for part in relative.split("/") if part]:
            if name in (".", ".."):
                raise Refused("SCOPE_DENIED", "Invalid preparation root")
            if create:
                try:
                    os.mkdir(name, 0o755, dir_fd=fd)
                except FileExistsError:
                    pass
            try:
                child = os.open(name, os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW | os.O_CLOEXEC,
                                dir_fd=fd)
            except OSError:
                raise Refused("SCOPE_DENIED", "A preparation root is not a directory")
            os.close(fd)
            fd = child
    except BaseException:
        os.close(fd)
        raise
    return fd


def native_error(native, error):
    code = ("SCOPE_DENIED" if isinstance(error, native.ScopeDenied)
            else errno.errorcode.get(getattr(error, "errno", None), "INVALID_NATIVE_REQUEST"))
    return {"error": {"code": code, "message": "Native operation failed"}}


def direct(request):
    """Native work on pinned descriptors without the launcher (no execution happens here)."""
    admit(request)
    verify_runtime(request["expect"])
    native = load(NATIVE, "capybara_native_files")
    kind = request["kind"]
    roots = {"read": [], "write": []}
    pinned = []
    try:
        if kind == "device":
            fd = os.open("/", os.O_RDONLY | os.O_DIRECTORY | os.O_CLOEXEC)
            pinned.append({"fd": fd})
            roots["write"].append({"path": "/", "fd": fd})
        elif kind == "scoped":
            if request.get("requireRestricted") or request["writeRoots"]:
                # Only read-only owner browsing runs here; restricted grants are not supported.
                raise Refused("UNAVAILABLE", "Restricted execution is not supported on this VM")
            write = pin(request["writeRoots"], True)
            pinned += write
            read = pin([p for p in request["readRoots"] if p not in request["writeRoots"]])
            pinned += read
            roots = {"read": [{"path": e["path"], "fd": e["fd"]} for e in read],
                     "write": [{"path": e["path"], "fd": e["fd"]} for e in write]}
        elif kind == "prepare":
            if protected(request["native"]["path"], False):
                raise Refused("SCOPE_DENIED", "The path is reserved for the provider")
            # Trusted staging: roots are mapped below a protected base, created when missing.
            for entry in request["prepareRoots"]:
                fd = pin_under(entry["base"], entry["relative"], True)
                pinned.append({"fd": fd})
                roots["write"].append({"path": entry["path"], "fd": fd})
        else:
            raise ValueError("unknown native kind")
        try:
            files = native.NativeFiles(roots)
            reply = {"result": files.run(request["native"])}
            if request.get("publicFiles") and request["native"]["method"] == "writeFile":
                # Skills are written by root and read by the sandbox user: 0644, like the
                # provider's ordinary skill writes, applied through the same pinned parent.
                parent, name = files.parent(request["native"]["path"], True)
                try:
                    fd = os.open(name, os.O_RDONLY | os.O_NOFOLLOW | os.O_NONBLOCK, dir_fd=parent)
                    try:
                        os.fchmod(fd, 0o644)
                    finally:
                        os.close(fd)
                finally:
                    os.close(parent)
        except Exception as error:
            reply = native_error(native, error)
        finish({"native": reply, "events": []})
    finally:
        close_pinned(pinned)


# ---- Full access: the provider's ordinary wrapper -----------------------------------------

NONCE_ENV = "CAPYBARA_ADMISSION_NONCE"
admission_nonce = [None]


def full(argv):
    # The nonce authenticates a refusal frame; it is removed before the command can see it.
    admission_nonce[0] = os.environ.pop(NONCE_ENV, None)
    request = {"opKey": argv[0], "admitBeforeMs": int(argv[1])}
    admit(request)
    if argv[3] != "--" or argv[4] != "setsid":
        raise ValueError("unexpected Full access command")
    os.execv("/usr/bin/setsid", argv[4:])


# ---- background executions ----------------------------------------------------------------
#
# Background executions run Full access work only (restricted grants are refused). Every
# trusted background record lives in the root-owned record directory (only root, the
# provider's own consumer steps, writes it; the sandbox user cannot even list it): the record,
# the output spool, the stop claim and the channel. A detached root recorder per execution owns
# them. The sandbox-user supervisor reaches it only through a root-owned UNIX socket whose random
# name the provider hands to the supervisor on stdin; the recorder accepts frames only on the one
# connection whose SO_PEERCRED pid is the supervisor that identified itself, and the supervisor is
# not dumpable, so restricted work cannot reach its channel and same-uid processes cannot reopen
# its descriptors once it runs. The identity frame carries a second random token (so the name
# that /proc/net/unix lists is not enough) and the digest of the request the supervisor runs; root
# recorded the digest of the request the provider admitted, and only a match is accepted. The
# token protects against discovery of the channel through /proc/net/unix; it is not unreadable:
# during bg-start's interpreter start-up (until PR_SET_DUMPABLE) same-uid processes can read its
# stdin through /proc. With it the real agent binds only a supervisor running exactly the granted
# request; a same-uid process running its own code can lie about the digest (the M5 residual). The
# provider aborts (stops whatever the record names) a refused start, a start whose bg-start did not
# exit 0 with one result frame, and an unacknowledged one whose record is contested (a second
# valid identity after the bind). A worker crash before the exec ended, followed by the same-ID
# retry, and a forger that ptraces the genuine bg-start stay open (M5, Task 14).

UUID = re.compile(r"[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}")
SECRET = re.compile(r"[0-9a-f]{32}")
READ_MAX = 65536
CANCEL_SIGNALS = {signal.SIGTERM, signal.SIGINT, signal.SIGHUP}


def bg_directory(execution, base=None):
    if not isinstance(execution, str) or not UUID.fullmatch(execution):
        raise ValueError("invalid execution id")
    return os.path.join(base or os.path.join(ops_dir(), "bg"), execution)


def write_json(path, value, mode=0o600):
    temporary = path + ".tmp"
    fd = os.open(temporary, os.O_WRONLY | os.O_CREAT | os.O_TRUNC | os.O_NOFOLLOW, mode)
    with os.fdopen(fd, "w") as handle:
        json.dump(value, handle)
    os.replace(temporary, path)


def read_json(path):
    try:
        with open(path) as handle:
            return json.load(handle)
    except (OSError, ValueError):
        return None


def proc_start(pid):
    """A live (non-zombie) process's start time, or None."""
    try:
        with open("/proc/%d/stat" % pid) as handle:
            data = handle.read()
        fields = data[data.rindex(")") + 2:].split()
        return None if fields[0] in ("Z", "X") else int(fields[19])
    except (OSError, ValueError, IndexError, TypeError):
        return None


def write_all(fd, data):
    view = memoryview(data)
    while view:
        view = view[os.write(fd, view):]


SPOOL_CAP = 64 * 1024 * 1024
PYTHON = "/usr/bin/python3"


def start_digest(start):
    """The digest of the canonical start request: every field the supervisor runs (command,
    scope, cwd, env, limits, output path...), i.e. the request without its channel name and token."""
    body = {key: value for key, value in start.items() if key not in ("secret", "token")}
    canonical = json.dumps(body, sort_keys=True, separators=(",", ":"), ensure_ascii=True)
    return hashlib.sha256(canonical.encode()).hexdigest()


def bg_prepare(request):
    """(root) Creates the execution's record, channel and recorder before anything launches."""
    records()
    directory = bg_directory(request["executionId"])
    secret = request["secret"]
    if not SECRET.fullmatch(secret):
        raise ValueError("invalid channel name")
    try:
        os.mkdir(directory, 0o711)
    except FileExistsError:
        return {"prepared": False, "existing": True}
    os.chmod(directory, 0o711)
    # A second random value that never appears in a path (unlike the socket name, which
    # /proc/net/unix lists): the supervisor's identity frame must carry it.
    token = request["token"]
    if not isinstance(token, str) or not SECRET.fullmatch(token):
        raise ValueError("invalid channel token")
    # The exact request the provider admitted: only a supervisor running it may bind the record.
    start = request["start"]
    if not isinstance(start, dict) or "secret" in start or "token" in start \
            or start.get("executionId") != request["executionId"] \
            or start.get("taskId") != request["taskId"] or start.get("opKey") != request.get("opKey"):
        raise ValueError("invalid start request")
    cap = request.get("spoolCapBytes") or SPOOL_CAP
    if type(cap) is not int or not 0 < cap <= SPOOL_CAP:
        raise ValueError("invalid spool cap")
    record = {"state": "starting", "generation": generation(), "taskId": request["taskId"],
              "opKey": request.get("opKey"), "retainUntilMs": request["retainUntilMs"],
              "expiresAtMs": request["retainUntilMs"] + 3600_000, "spoolCapBytes": cap,
              "startDigest": start_digest(start)}
    write_json(os.path.join(directory, "record.json"), record)
    ready_r, ready_w = os.pipe()
    pid = os.fork()
    if pid == 0:
        try:
            os.close(ready_r)
            os.setsid()
            if os.fork() != 0:
                os._exit(0)
            null = os.open("/dev/null", os.O_RDWR)
            for fd in (0, 1, 2):
                os.dup2(null, fd)
            bg_recorder(directory, secret, token, record, ready_w)
        finally:
            os._exit(0)
    os.close(ready_w)
    os.waitpid(pid, 0)
    ready = os.read(ready_r, 1)
    os.close(ready_r)
    if ready != b"R":
        raise Refused("INVALID_REQUEST", "The background recorder did not start")
    return {"prepared": True, "generation": record["generation"]}


def peer(conn):
    """The connecting process's (pid, uid) from SO_PEERCRED, fixed by the kernel at connect."""
    data = conn.getsockopt(socket.SOL_SOCKET, socket.SO_PEERCRED, 12)
    pid, uid, _ = struct.unpack("3i", data)
    return pid, uid


def is_supervisor(pid):
    """The process runs this agent's bg-start exactly as the provider calls it (the supervisor
    it forks keeps that argv). A same-uid process can run its own code under this argv, so this
    is a filter; the token and the request digest bind the real agent to the admitted request."""
    try:
        with open("/proc/%d/cmdline" % pid, "rb") as handle:
            args = handle.read().split(b"\0")
    except OSError:
        return False
    return args == [os.fsencode(PYTHON), b"-I", os.fsencode(os.path.abspath(__file__)),
                    b"bg-start", b""]


def bg_recorder(directory, secret, token, record, ready_w):
    """(root, detached) Appends output and records the supervisor's identity and exit. The
    channel is a root-owned UNIX socket: frames count only on the one connection whose
    SO_PEERCRED pid is the supervisor that identified itself (pid, start time, argv, token and
    the digest of the request it runs, which must be the admitted one); no other peer, and no
    writer that reopens a descriptor, can add frames to it."""
    import select as select_module
    os.chdir(directory)  # bind relative: the absolute path would exceed sun_path
    listener = socket.socket(socket.AF_UNIX, socket.SOCK_STREAM)
    listener.bind(secret)
    os.chmod(secret, 0o622)  # the sandbox user may connect by its exact name only
    listener.listen(8)
    spool = os.open("output", os.O_WRONLY | os.O_CREAT | os.O_EXCL | os.O_APPEND | os.O_CLOEXEC,
                    0o600)
    path = os.path.join(directory, "record.json")
    os.write(ready_w, b"R")
    os.close(ready_w)
    cap = record["spoolCapBytes"]
    written = 0
    bound = None
    buffer = bytearray()
    pending = {}  # unverified connections: fd -> (socket, buffer, deadline)
    connect_by = time.monotonic() + 120
    poller = select_module.poll()
    poller.register(listener.fileno(), select_module.POLLIN)

    def drop(fd):
        conn = pending.pop(fd, (None,))[0]
        if conn is not None:
            poller.unregister(fd)
            conn.close()
    try:
        while True:
            events = dict(poller.poll(1000))
            if listener.fileno() in events:
                conn, _ = listener.accept()
                if len(pending) >= 8:
                    conn.close()
                else:
                    # Also after the bind: a later valid identity (one supervisor per execution
                    # binds) marks the record contested, since one of the two is not genuine.
                    conn.setblocking(False)
                    pending[conn.fileno()] = (conn, bytearray(), time.monotonic() + 10)
                    poller.register(conn.fileno(), select_module.POLLIN)
            for fd in list(pending):
                conn, data, deadline = pending[fd]
                if fd in events:
                    try:
                        chunk = conn.recv(4096)
                    except BlockingIOError:
                        chunk = None
                    if chunk == b"":
                        drop(fd)
                        continue
                    if chunk:
                        data += chunk
                if len(data) >= 5 and data[0:1] == b"P":
                    size = int.from_bytes(data[1:5], "big")
                    if size > 4096:
                        drop(fd)
                        continue
                    if len(data) < 5 + size:
                        continue
                    try:
                        identity = json.loads(bytes(data[5:5 + size]))
                        claimed, start = int(identity["pid"]), int(identity["start"])
                        offered = str(identity["token"]).encode()
                        digest = str(identity["digest"]).encode()
                        pid, uid = peer(conn)
                    except (ValueError, KeyError, OSError, struct.error):
                        drop(fd)
                        continue
                    cancelled = record.get("opKey") and os.path.exists(
                        os.path.join(OPS_ROOT, record["opKey"] + ".cancelled"))
                    valid = hmac.compare_digest(offered, token.encode()) \
                        and hmac.compare_digest(digest, record["startDigest"].encode()) \
                        and pid == claimed and uid != 0 and proc_start(pid) == start \
                        and is_supervisor(pid)
                    if valid and bound is not None and not record.get("contested"):
                        # Two supervisors presented the token and the admitted digest: the bound
                        # one may be a forgery. The provider stops a contested start whose
                        # acknowledgement it did not receive.
                        record = dict(record, contested=True)
                        write_json(path, record)
                    if not valid or bound is not None or record["state"] != "starting" \
                            or cancelled:
                        # Refused (or a stop already cancelled this execution): close without
                        # the acceptance byte, so that supervisor never acknowledges or launches.
                        drop(fd)
                        continue
                    pending.pop(fd)
                    try:
                        conn.send(b"A")  # acceptance: only now may the supervisor proceed
                    except OSError:
                        write_json(path, dict(record, state="lost"))
                        return
                    bound = conn
                    buffer = bytearray(data[5 + size:])
                    record = dict(record, state="running", pid=pid, start=start,
                                  boundDigest=digest.decode())
                    write_json(path, record)
                elif len(data) >= 1 and data[0:1] != b"P" or time.monotonic() > deadline:
                    drop(fd)
            if bound is not None and bound.fileno() in events:
                try:
                    chunk = bound.recv(CHUNK + 5)
                except BlockingIOError:
                    chunk = None
                if chunk == b"":
                    # The supervisor closed its channel without reporting an exit.
                    write_json(path, dict(record, state="lost"))
                    return
                if chunk:
                    buffer += chunk
            while bound is not None and len(buffer) >= 5:
                size = int.from_bytes(buffer[1:5], "big")
                if size > CHUNK or buffer[0:1] not in (b"O", b"X"):
                    write_json(path, dict(record, state="lost"))
                    return
                if len(buffer) < 5 + size:
                    break
                kind, body = bytes(buffer[0:1]), bytes(buffer[5:5 + size])
                del buffer[:5 + size]
                if kind == b"O":
                    keep = body[:max(cap - written, 0)]
                    if keep:
                        write_all(spool, keep)
                        written += len(keep)
                    if len(keep) < len(body) and not record.get("outputTruncated"):
                        record = dict(record, outputTruncated=True)
                        write_json(path, record)
                else:
                    result = json.loads(body)
                    record = dict(record, state="exited", exitCode=result.get("exitCode"),
                                  timedOut=bool(result.get("timedOut")),
                                  cancelled=bool(result.get("cancelled")),
                                  refused=result.get("refused"))
                    write_json(path, record)
                    return
            if record["state"] == "starting" and (time.monotonic() > connect_by or (
                    record.get("opKey") and os.path.exists(
                        os.path.join(OPS_ROOT, record["opKey"] + ".cancelled")))):
                # No supervisor in time, or the start was cancelled: nothing may bind any more.
                write_json(path, dict(record, state="lost"))
                return
            if record["state"] == "running" and not events and \
                    proc_start(record["pid"]) != record["start"]:
                write_json(path, dict(record, state="lost"))
                return
    finally:
        try:
            os.unlink(os.path.join(directory, secret))
        except OSError:
            pass


def open_output(request):
    """Opens the requested output artifact inside the scope (pinned roots, no-follow)."""
    native = load(NATIVE, "capybara_native_files")
    pinned = []
    try:
        if request["kind"] == "device":
            fd = os.open("/", os.O_RDONLY | os.O_DIRECTORY | os.O_CLOEXEC)
            pinned.append({"fd": fd})
            roots = {"read": [], "write": [{"path": "/", "fd": fd}]}
        else:
            raise Refused("UNAVAILABLE", "Restricted execution is not supported on this VM")
        if protected(request["outputPath"], True):
            raise Refused("SCOPE_DENIED", "The output path is reserved for the provider")
        try:
            out = native.NativeFiles(roots).open(request["outputPath"], write=True)
        except (native.ScopeDenied, OSError, ValueError):
            raise Refused("SCOPE_DENIED", "The output path is outside the operation scope")
        try:
            if not stat.S_ISREG(os.fstat(out).st_mode):
                raise Refused("SCOPE_DENIED", "The output path is not a regular file")
            os.ftruncate(out, 0)
            os.set_inheritable(out, False)
        except BaseException:
            os.close(out)
            raise
        return out
    finally:
        close_pinned(pinned)


class Channel:
    """The supervisor's side of the recorder socket: whole frames under one lock."""

    def __init__(self, fd):
        self.fd = fd
        self.lock = threading.Lock()

    def send(self, kind, data):
        with self.lock:
            try:
                for at in range(0, max(len(data), 1), CHUNK):
                    part = data[at:at + CHUNK]
                    write_all(self.fd, kind + len(part).to_bytes(4, "big") + part)
            except OSError:
                pass  # A lost recorder records the execution as lost; the work continues.


def bg_start(request):
    """(sandbox user) Starts the detached supervisor; acknowledges once it is recorded. The
    process turns undumpable before it reads the request, so once it runs other processes of the
    same user cannot reopen its descriptors through /proc; during interpreter start-up they can
    (stdin included), which the request digest and the provider's stop on failure cover."""
    admit(request)
    verify_runtime(request["expect"])
    address = os.path.join(bg_directory(request["executionId"], os.path.join(OPS_VIEW, "bg")),
                           request["secret"])
    if not SECRET.fullmatch(request["secret"]):
        raise ValueError("invalid channel name")
    out = open_output(request)
    ready_r, ready_w = os.pipe()
    pid = os.fork()
    if pid == 0:
        try:
            os.close(ready_r)
            os.setsid()
            if os.fork() != 0:
                os._exit(0)
            null = os.open("/dev/null", os.O_RDWR)
            for fd in (0, 1, 2):
                os.dup2(null, fd)
            # The supervisor itself connects, so the recorder's SO_PEERCRED names exactly it.
            connection = socket.socket(socket.AF_UNIX, socket.SOCK_STREAM)
            connection.connect(address)
            bg_supervise(request, Channel(connection.detach()), out, ready_w)
        finally:
            os._exit(0)
    os.close(ready_w)
    os.close(out)
    os.waitpid(pid, 0)
    ready = os.read(ready_r, 1)
    os.close(ready_r)
    if ready != b"R":
        raise Refused("INVALID_REQUEST", "The background supervisor did not start")
    finish({"started": True})


def unblock():
    signal.pthread_sigmask(signal.SIG_UNBLOCK, CANCEL_SIGNALS)


def bg_supervise(request, channel, out, ready_w):
    """The detached supervisor: blocks cancellation, reports its identity to the recorder before
    acknowledging, re-checks admission, then launches with its handlers in place."""
    signal.pthread_sigmask(signal.SIG_BLOCK, CANCEL_SIGNALS)
    me = os.getpid()
    # The digest of the request this supervisor runs: the recorder accepts only the admitted one.
    channel.send(b"P", json.dumps({"pid": me, "start": proc_start(me), "token": request["token"],
                                   "digest": start_digest(request)}).encode())
    # Fail closed: without the recorder's acceptance on this very connection (another peer was
    # bound, or the execution was cancelled), never acknowledge and never launch.
    import select as select_module
    ready, _, _ = select_module.select([channel.fd], [], [], 30)
    try:
        accepted = os.read(channel.fd, 1) if ready else b""
    except OSError:
        accepted = b""
    if accepted != b"A":
        os._exit(0)
    os.write(ready_w, b"R")
    os.close(ready_w)

    def sink(data):
        channel.send(b"O", data)
        try:
            write_all(out, data)
        except OSError:
            pass

    def done(result):
        events = result.get("events", [])
        exit_event = next((e for e in events if e.get("event") == "exit"), None) or {}
        refused = next((e for e in events if e.get("event") == "refused"), None)
        code = exit_event.get("exitCode")
        if isinstance(code, int) and code < 0:
            code = 128 - code
        timed_out = bool(exit_event.get("timedOut"))
        channel.send(b"X", json.dumps({
            "exitCode": None if timed_out or refused else code, "timedOut": timed_out,
            "cancelled": bool(result.get("cancelled")),
            "refused": refused.get("code") if refused else None}).encode())
    try:
        # A revocation or cancellation recorded after the start acknowledgement still wins.
        admit(request)
        if request["kind"] != "device":
            raise Refused("UNAVAILABLE", "Restricted execution is not supported on this VM")
        full_supervise(request, sink, done)
    except Refused as error:
        done({"events": [{"event": "refused", "code": error.code}], "cancelled": False})
    except Exception:
        done({"events": [{"event": "refused", "code": "INVALID_REQUEST"}], "cancelled": False})


def full_supervise(request, sink, done):
    """Full access in the background: the existing OS user and environment, no restricted filter;
    the owned process group ends on stop, timeout and exit, and an in-sandbox time limit bounds
    it even if this supervisor is lost."""
    env = dict(os.environ)
    env.update(request.get("env") or {})
    cancelled = []
    seconds = str(int(request["timeoutMs"] / 1000) + 6)
    child = subprocess.Popen(["/usr/bin/timeout", "-s", "KILL", seconds, "/bin/bash", "-c",
                              request["command"]], cwd=request.get("cwd") or None, env=env,
                             stdin=subprocess.DEVNULL, stdout=subprocess.PIPE,
                             stderr=subprocess.STDOUT, start_new_session=True, preexec_fn=unblock)

    def cancel(signum, _frame):
        cancelled.append(signum)
        try:
            os.killpg(child.pid, signal.SIGKILL)
        except OSError:
            pass
    for number in CANCEL_SIGNALS:
        signal.signal(number, cancel)
    # A stop that arrived while blocked is delivered now, with the child known.
    unblock()

    def copy():
        while True:
            data = child.stdout.read1(CHUNK)
            if not data:
                return
            sink(data)
    reader = threading.Thread(target=copy, daemon=True)
    reader.start()
    timed_out = False
    try:
        code = child.wait(timeout=request["timeoutMs"] / 1000)
    except subprocess.TimeoutExpired:
        timed_out = True
        try:
            os.killpg(child.pid, signal.SIGKILL)
        except OSError:
            pass
        code = child.wait()
    try:
        os.killpg(child.pid, signal.SIGKILL)
    except OSError:
        pass
    # A detached descendant may keep the pipe; the record does not wait for it.
    reader.join(5)
    done({"events": [{"event": "exit", "exitCode": None if timed_out or cancelled else code,
                      "timedOut": timed_out}], "cancelled": bool(cancelled)})


def bg_lookup(request, any_generation=False):
    directory = bg_directory(request["executionId"])
    record = read_json(os.path.join(directory, "record.json"))
    if record is None:
        return directory, None
    if not any_generation and record.get("generation") != request.get("generation"):
        return None, None
    stop = read_json(os.path.join(directory, "stop.json"))
    bound = record.get("state") in ("running", "exited")
    if (stop is not None and stop.get("aborted")) or (bound and not hmac.compare_digest(
            str(record.get("boundDigest", "")).encode(),
            str(record.get("startDigest", "-")).encode())):
        # A start the provider aborted (refused or never acknowledged), or a record bound to any
        # request but the admitted one: never reported as the task, its spool never served.
        record = dict(record, state="lost", withheld=True)
    return directory, record


def bg_state(record):
    if record is None:
        return {"state": "lost"}
    state = record.get("state")
    if state in ("starting", "running"):
        if state == "running" and proc_start(record["pid"]) != record["start"]:
            return {"state": "lost"}
        return {"state": "running"}
    if state == "exited":
        return {"state": "exited", "exitCode": record.get("exitCode"),
                "timedOut": bool(record.get("timedOut"))}
    return {"state": "lost"}


def bg_status(request):
    _, record = bg_lookup(request)
    return bg_state(record)


def bg_contested(request):
    """(root) Whether two supervisors presented this execution's token and admitted digest."""
    _, record = bg_lookup(request)
    return {"contested": bool(record is not None and record.get("contested"))}


def bg_expired(record):
    return record is not None and record.get("state") == "exited" \
        and time.time() * 1000 > record.get("retainUntilMs", 0)


def bg_output(request, tail):
    directory, record = bg_lookup(request)
    if directory is None:
        if tail:
            return {"unavailable": "lost"}
        raise Refused("SCOPE_DENIED", "The reference names another instance generation")
    if bg_expired(record):
        return {"unavailable": "expired"}
    if record is None or record.get("withheld"):
        return {"unavailable": "lost"}
    try:
        fd = os.open(os.path.join(directory, "output"), os.O_RDONLY | os.O_NOFOLLOW | os.O_CLOEXEC)
    except OSError:
        return {"unavailable": "lost"}
    try:
        total = os.fstat(fd).st_size
        if tail:
            want = min(request["maxBytes"], total)
            data = os.pread(fd, want, total - want)
            truncated = total > want
            cut = 0
            while cut < len(data) and cut < 4 and data[cut] & 0xC0 == 0x80:
                cut += 1
            return {"dataB64": base64.b64encode(data[cut:]).decode(), "truncated": truncated}
        offset = request["offset"]
        want = min(request["maxBytes"], max(total - offset, 0))
        data = b""
        while len(data) < want:
            chunk = os.pread(fd, want - len(data), offset + len(data))
            if not chunk:
                return {"unavailable": "lost"}
            data += chunk
        return {"dataB64": base64.b64encode(data).decode(), "offset": offset,
                "nextOffset": offset + len(data), "totalBytes": total}
    finally:
        os.close(fd)


def bg_stop_plan(request):
    """(root) The claimed outcome, or the recorded identity the stop must signal."""
    directory, record = bg_lookup(request, request.get("anyGeneration", False))
    if directory is None or record is None:
        return {"outcome": {"outcome": "lost"}}
    prior = read_json(os.path.join(directory, "stop.json"))
    if prior is not None:
        return {"outcome": prior}
    deadline = time.monotonic() + 5
    while record is not None and record.get("state") == "starting" and time.monotonic() < deadline:
        time.sleep(0.02)
        record = read_json(os.path.join(directory, "record.json"))
    state = bg_state(record)
    if state["state"] == "running" and record.get("state") == "running":
        return {"signal": {"pid": record["pid"], "start": record["start"]}}
    return {"state": state}


def bg_signal(request):
    """(sandbox user) Ends one recorded supervisor: SIGTERM, then SIGKILL; never a reused pid."""
    pid, start = int(request["pid"]), int(request["start"])
    if proc_start(pid) != start:
        return {"signalled": False}
    try:
        handle = os.pidfd_open(pid)
    except OSError:
        return {"signalled": False}
    try:
        if proc_start(pid) != start:
            return {"signalled": False}
        signal.pidfd_send_signal(handle, signal.SIGTERM)
        deadline = time.monotonic() + min(request.get("graceMs", 0) / 1000, 5) + 6
        while proc_start(pid) == start and time.monotonic() < deadline:
            time.sleep(0.02)
        if proc_start(pid) == start:
            signal.pidfd_send_signal(handle, signal.SIGKILL)
        return {"signalled": True}
    except OSError:
        return {"signalled": False}
    finally:
        os.close(handle)


def bg_stop_claim(request):
    """(root) Atomically claims the terminal outcome; a retry returns the same outcome."""
    directory, record = bg_lookup(request, request.get("anyGeneration", False))
    if directory is None or record is None:
        return {"outcome": "lost"}
    stop_path = os.path.join(directory, "stop.json")
    prior = read_json(stop_path)
    if prior is not None:
        return prior
    deadline = time.monotonic() + 5
    while record is not None and record.get("state") in ("starting", "running") \
            and time.monotonic() < deadline:
        time.sleep(0.02)
        record = read_json(os.path.join(directory, "record.json"))
    if record is not None and record.get("state") == "starting" and record.get("opKey"):
        # No supervisor reported in time: a late one must not launch after this claim.
        marker({"opKey": record["opKey"], "expiresAtMs": record.get("expiresAtMs", 0)},
               ".cancelled")
        record = dict(record, state="lost")
        write_json(os.path.join(directory, "record.json"), record)
    state = bg_state(record)
    if record is not None and record.get("state") == "exited" and not record.get("cancelled") \
            and not request.get("signalled"):
        outcome = {"outcome": "already-exited", "exitCode": state.get("exitCode"),
                   "timedOut": state.get("timedOut", False)}
    elif request.get("signalled") or (record is not None and record.get("cancelled")):
        outcome = {"outcome": "stopped"}
    elif state["state"] == "exited":
        outcome = {"outcome": "already-exited", "exitCode": state.get("exitCode"),
                   "timedOut": state.get("timedOut", False)}
    else:
        outcome = {"outcome": "lost"}
    if request.get("aborted"):
        # The provider aborts a start it did not see acknowledged: from now on the reference
        # reports the execution as lost and serves none of its output.
        outcome = dict(outcome, aborted=True)
    try:
        write_new(stop_path, outcome, 0o600)
    except FileExistsError:
        return read_json(stop_path) or outcome
    return outcome


# ---- durable records (root) ---------------------------------------------------------------

def generation():
    with open("/proc/sys/kernel/random/boot_id") as handle:
        boot = handle.read().strip()
    with open("/proc/1/stat") as handle:
        data = handle.read()
    started = data[data.rindex(")") + 2:].split()[19]
    return hashlib.sha256(("%s/%s" % (boot, started)).encode()).hexdigest()[:24]


def records():
    """(root) The record directory on the VM's persistent disk: the sandbox user can neither
    create, list nor change it (a planted path is refused, never trusted)."""
    for path in (OPS_ROOT, os.path.join(OPS_ROOT, "bg")):
        try:
            os.mkdir(path, 0o711)
        except FileExistsError:
            pass
        info = os.lstat(path)
        if not stat.S_ISDIR(info.st_mode) or info.st_uid != 0 or info.st_mode & 0o7777 != 0o711:
            raise Refused("UNAVAILABLE", "The operation record directory is not trusted")
    now = time.time() * 1000
    for name in os.listdir(OPS_ROOT):
        path = os.path.join(OPS_ROOT, name)
        if name == "bg":
            continue
        try:
            with open(path) as handle:
                expires = json.load(handle).get("expiresAtMs", 0)
            if now > expires + 3600_000:
                os.unlink(path)
        except (OSError, ValueError):
            pass
    base = os.path.join(OPS_ROOT, "bg")
    for name in os.listdir(base):
        record = read_json(os.path.join(base, name, "record.json"))
        stale = record is not None and (record.get("state") in ("exited", "lost")
                                        or record.get("generation") != generation())
        if stale and now > record.get("expiresAtMs", 0):
            shutil.rmtree(os.path.join(base, name), ignore_errors=True)


def write_new(path, record, mode):
    fd = os.open(path, os.O_WRONLY | os.O_CREAT | os.O_EXCL | os.O_NOFOLLOW, mode)
    with os.fdopen(fd, "w") as handle:
        json.dump(record, handle)


def consume(request):
    records()
    key = request["opKey"]
    if os.path.exists(os.path.join(OPS_ROOT, key + ".revoked")):
        return {"state": "revoked"}
    path = os.path.join(OPS_ROOT, key + ".json")
    record = {"generation": generation(), "method": request["method"],
              "inputHash": request["inputHash"], "expiresAtMs": request["expiresAtMs"]}
    if time.time() * 1000 > request["admitBeforeMs"]:
        if os.path.exists(path):
            return lookup(path, record)
        return {"state": "expired"}
    try:
        write_new(path, record, 0o600)
        return {"state": "new", "generation": record["generation"]}
    except FileExistsError:
        return lookup(path, record)


def lookup(path, record):
    with open(path) as handle:
        existing = json.load(handle)
    # The same method and input is a duplicate in any generation (an unknown outcome, never a
    # re-run); a different method or input under the ID is invalid.
    if (existing.get("method"), existing.get("inputHash")) != (
            record["method"], record["inputHash"]):
        return {"state": "mismatch"}
    return {"state": "duplicate", "record": existing}


def marker(request, suffix):
    """(root) A tombstone or cancellation marker the sandbox-user agent checks before launching."""
    records()
    try:
        write_new(os.path.join(OPS_ROOT, request["opKey"] + suffix),
                  {"expiresAtMs": request["expiresAtMs"]}, 0o644)
    except FileExistsError:
        pass
    return {"state": "revoked" if suffix == ".revoked" else "cancelled",
            "generation": generation()}


# ---- entry --------------------------------------------------------------------------------

ROOT_COMMANDS = {"init", "consume", "revoke", "cancel-mark", "bg-prepare", "bg-status", "bg-tail",
                 "bg-read", "bg-stop-plan", "bg-stop-claim", "bg-contested"}


def main():
    command = sys.argv[1] if len(sys.argv) > 1 else ""
    try:
        if command == "full":
            try:
                full(sys.argv[2:])
            except Refused as error:
                # Nothing ran: the only output is this refusal frame (with the provider's nonce),
                # and the exit code is 125.
                finish({"nonce": admission_nonce[0], "events": [
                    {"event": "refused", "code": error.code, "message": str(error)}]})
            except Exception as error:
                # Any other failure before exec is a refusal too, never an apparent success.
                finish({"nonce": admission_nonce[0], "events": [
                    {"event": "refused", "code": "INVALID_REQUEST",
                     "message": type(error).__name__}]})
            return 125
        if command == "bg-start":
            libc.prctl(4, 0, 0, 0, 0)  # PR_SET_DUMPABLE 0, before the request is read
        if command == "probe":
            done = subprocess.run([sys.executable, "-I", LAUNCHER, "probe"], capture_output=True)
            finish({"probe": json.loads(done.stdout), "kernel": os.uname().release})
            return 0
        request = read_request()
        if command in ROOT_COMMANDS and os.getuid() != 0:
            raise ValueError("root-only command")
        if command == "direct":
            direct(request)
        elif command == "init":
            records()  # also prunes expired records and spools when the instance starts
            finish({"ready": True})
        elif command == "consume":
            finish(consume(request))
        elif command == "revoke":
            finish(marker(request, ".revoked"))
        elif command == "cancel-mark":
            finish(marker(request, ".cancelled"))
        elif command == "bg-prepare":
            finish(bg_prepare(request))
        elif command == "bg-start":
            bg_start(request)
        elif command == "bg-status":
            finish(bg_status(request))
        elif command == "bg-contested":
            finish(bg_contested(request))
        elif command == "bg-tail":
            finish(bg_output(request, True))
        elif command == "bg-read":
            finish(bg_output(request, False))
        elif command == "bg-stop-plan":
            finish(bg_stop_plan(request))
        elif command == "bg-signal":
            finish(bg_signal(request))
        elif command == "bg-stop-claim":
            finish(bg_stop_claim(request))
        else:
            raise ValueError("unknown command")
        return 0
    except Refused as error:
        finish({"events": [{"event": "refused", "code": error.code, "message": str(error)}]})
        return 0
    except Exception as error:
        finish({"events": [{"event": "refused", "code": "INVALID_REQUEST",
                            "message": "%s" % type(error).__name__}]})
        return 0


if __name__ == "__main__":
    sys.exit(main())
