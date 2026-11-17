# Trusted in-container consumer of the SDK's Linux runtime for the sandbox-docker provider (staged
# root-owned and hash-checked next to linux-sandbox.py and native-files.py). It never decides
# authority: every request carries the operation's immutable scope, already resolved by the kernel.
#
#   exec / native   restricted work (run as the sandbox user): pins the granted roots once, runs the
#                   launcher (Landlock plus the seccomp broker) on those descriptors and streams its
#                   output as frames; the same pinned descriptors serve rules, broker and helper.
#   direct          native work without the launcher (Full access on "/", read-only scopes, owner
#                   browsing, trusted preparation); descriptor-relative, no-follow traversal.
#   full            Full access exec: checks admission, then execs the provider's ordinary wrapper.
#   cancel          ends one exact operation by its control path (SIGTERM, then SIGKILL).
#   bg-*            background executions: a detached trusted supervisor per operation, with an
#                   append-only output spool and a status record (start/status/tail/read/stop).
#   probe           the launcher's own probe.
#   consume/revoke  (root) the durable operation records and tombstones in /tmp/.capybara-ops.
import base64
import ctypes
import errno
import hashlib
import importlib.util
import json
import os
import re
import shutil
import signal
import socket
import stat
import subprocess
import sys
import threading
import time

RUNTIME = os.path.dirname(os.path.abspath(__file__))
LAUNCHER = os.path.join(RUNTIME, "linux-sandbox.py")
NATIVE = os.path.join(RUNTIME, "native-files.py")
OPS = "/tmp/.capybara-ops"
MARKER = "capybara-exec"
CHUNK = 65536
PROXY_KEYS = ("HTTP_PROXY", "HTTPS_PROXY", "http_proxy", "https_proxy", "ALL_PROXY", "all_proxy",
              "GRPC_PROXY", "grpc_proxy", "NO_PROXY", "no_proxy", "GIT_SSH_COMMAND")
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


def admit(request):
    """Refuses a revoked operation, a passed admission deadline or a requested cancellation."""
    key = request.get("opKey")
    if key and os.path.exists(os.path.join(OPS, key + ".revoked")):
        raise Refused("REVOKED", "The operation was revoked")
    deadline = request.get("admitBeforeMs")
    if deadline is not None and time.time() * 1000 > deadline:
        raise Refused("EXPIRED", "The operation's admission deadline passed")
    ctl = request.get("ctl")
    if ctl and os.path.exists(ctl + ".kill"):
        raise Refused("CANCELLED", "The operation was cancelled before it started")


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


def pin(paths):
    """Opens each existing granted root once (no-follow, canonical) and records its identity.

    A root that does not exist grants nothing and is left out; a root that is not a real
    directory at its canonical path (a swapped symlink, for example) refuses the operation."""
    pinned = []
    try:
        for path in paths:
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


# ---- per-operation allowlist forwarder ----------------------------------------------------

def host_allowed(host, hosts):
    host = host.lower().rstrip(".")
    for entry in hosts:
        if entry.startswith("*."):
            if host.endswith(entry[1:]) and host != entry[2:]:
                return True
        elif host == entry:
            return True
    return False


def split_target(target, default_port):
    if target.startswith("["):
        return None, None  # allowlist hosts are names, never address literals
    host, _, port = target.partition(":")
    try:
        number = int(port) if port else default_port
    except ValueError:
        return None, None
    if not host or not 0 < number < 65536:
        return None, None
    return host, number


class Forwarder:
    """A loopback HTTP proxy owned by one operation: CONNECT and absolute http:// requests to the
    operation's allowlisted hosts become CONNECT tunnels through the instance's egress proxy, which
    still applies the instance network. Only this operation's broker grants its endpoint."""

    def __init__(self, hosts, upstream):
        self.hosts = hosts
        self.upstream = upstream
        self.server = socket.socket(socket.AF_INET, socket.SOCK_STREAM)
        self.server.bind(("127.0.0.1", 0))
        self.server.listen(64)
        self.port = self.server.getsockname()[1]
        threading.Thread(target=self.accept, daemon=True).start()

    def accept(self):
        while True:
            try:
                client, _ = self.server.accept()
            except OSError:
                return
            threading.Thread(target=self.handle, args=(client,), daemon=True).start()

    @staticmethod
    def splice(a, b):
        def pump(src, dst):
            try:
                while True:
                    data = src.recv(CHUNK)
                    if not data:
                        break
                    dst.sendall(data)
            except OSError:
                pass
            for sock in (src, dst):
                try:
                    sock.shutdown(socket.SHUT_RDWR)
                except OSError:
                    pass
        threading.Thread(target=pump, args=(b, a), daemon=True).start()
        pump(a, b)

    def tunnel(self, host, port):
        if self.upstream is None:
            return None, b""
        up = socket.create_connection(self.upstream, 30)
        up.sendall(("CONNECT %s:%d HTTP/1.1\r\nHost: %s:%d\r\n\r\n" % (host, port, host, port)).encode())
        head = b""
        while b"\r\n\r\n" not in head:
            data = up.recv(4096)
            if not data or len(head) > 16384:
                up.close()
                return None, b""
            head += data
        status, _, rest = head.partition(b"\r\n\r\n")
        parts = status.split(b" ")
        if len(parts) < 2 or parts[1] != b"200":
            up.close()
            return None, status + b"\r\n\r\n"
        up.settimeout(None)
        return up, rest

    def handle(self, client):
        try:
            client.settimeout(30)
            head = b""
            while b"\r\n\r\n" not in head:
                data = client.recv(4096)
                if not data or len(head) > 16384:
                    client.close()
                    return
                head += data
            head, _, body = head.partition(b"\r\n\r\n")
            lines = head.split(b"\r\n")
            method, target, version = (lines[0].decode("latin-1").split(" ") + ["", "", ""])[:3]
            if method == "CONNECT":
                host, port = split_target(target, 443)
                rewritten = None
            elif target.startswith("http://"):
                authority, _, path = target[7:].partition("/")
                host, port = split_target(authority, 80)
                headers = [line for line in lines[1:]
                           if not line.lower().startswith((b"proxy-", b"connection:"))]
                rewritten = ("%s /%s %s\r\n" % (method, path, version)).encode() + b"\r\n".join(
                    headers + [b"Connection: close"]) + b"\r\n\r\n"
            else:
                host, port = None, None
                rewritten = None
            if host is None or not host_allowed(host, self.hosts):
                client.sendall(b"HTTP/1.1 403 Forbidden\r\nContent-Length: 0\r\n"
                               b"Connection: close\r\n\r\n")
                client.close()
                return
            up, early = self.tunnel(host, port)
            if up is None:
                client.sendall(early or b"HTTP/1.1 502 Bad Gateway\r\nContent-Length: 0\r\n"
                               b"Connection: close\r\n\r\n")
                client.close()
                return
            client.settimeout(None)
            if rewritten is None:
                client.sendall(b"HTTP/1.1 200 Connection established\r\n\r\n")
                if body:
                    up.sendall(body)
            else:
                up.sendall(rewritten + body)
            if early:
                client.sendall(early)
            self.splice(client, up)
        except OSError:
            try:
                client.close()
            except OSError:
                pass

    def close(self):
        try:
            self.server.close()
        except OSError:
            pass


def upstream_proxy():
    value = os.environ.get("HTTPS_PROXY") or os.environ.get("HTTP_PROXY")
    if not value or not value.startswith("http://"):
        return None
    host, port = split_target(value[7:].rstrip("/"), 3128)
    return None if host is None else (host, port)


def network_for(request, forwarders):
    """The launcher's network and the child's proxy environment for the operation scope."""
    scope = request["network"]
    env = {key: value for key, value in os.environ.items() if key not in PROXY_KEYS}
    if scope["kind"] == "environment":
        env.update({key: os.environ[key] for key in PROXY_KEYS if key in os.environ})
        return {"kind": "environment"}, env
    if scope["kind"] == "none":
        return {"kind": "none"}, env
    endpoints = []
    direct = []
    # Test-only direct endpoints (DockerSandboxTestOptions.permissionTestEndpoints).
    for host in scope["hosts"]:
        for endpoint in request.get("testEndpoints", {}).get(host, []):
            endpoints.append({"address": endpoint["address"], "port": endpoint["port"]})
            direct.append(host)
    forwarder = Forwarder(scope["hosts"], upstream_proxy())
    forwarders.append(forwarder)
    endpoints.append({"address": "127.0.0.1", "port": forwarder.port})
    proxy = "http://127.0.0.1:%d" % forwarder.port
    for key in ("HTTP_PROXY", "HTTPS_PROXY", "http_proxy", "https_proxy", "ALL_PROXY", "all_proxy"):
        env[key] = proxy
    no_proxy = ",".join(["localhost", "127.0.0.1", "::1"] + direct)
    env["NO_PROXY"] = env["no_proxy"] = no_proxy
    return {"kind": "endpoints", "endpoints": endpoints}, env


# ---- restricted launch --------------------------------------------------------------------

def pdeathsig():
    # The launcher cancels (and ends its whole tree) if this agent is lost.
    libc.prctl(1, signal.SIGTERM, 0, 0, 0)


def restricted(mode, request, sink=None, done=None):
    admit(request)
    verify_runtime(request["expect"])
    write_paths = request["writeRoots"]
    write = pin(write_paths)
    read = []
    forwarders = []
    try:
        read = pin([path for path in request["readRoots"] if path not in write_paths])
        if not write:
            raise Refused("SCOPE_DENIED", "Restricted execution needs an existing writable root")
        network, env = network_for(request, forwarders) if mode == "exec" else ({"kind": "none"}, {})
        env.update(request.get("env") or {})
        report_r, report_w = os.pipe()
        body = {"mode": mode, "roots": {"read": read, "write": write}, "network": network,
                "reportFd": report_w, "env": env or None, "cwd": request.get("cwd")}
        if mode == "exec":
            body["argv"] = ["/bin/sh", "-c", request["command"]]
            body["timeoutMs"] = request["timeoutMs"]
        else:
            body["native"] = request["native"]
        try:
            launcher = subprocess.Popen(
                [sys.executable, "-I", LAUNCHER], stdin=subprocess.PIPE, stdout=subprocess.PIPE,
                stderr=subprocess.PIPE, pass_fds=[report_w] + [e["fd"] for e in read + write],
                env={"PATH": "/usr/local/bin:/usr/bin:/bin", "LANG": "C.UTF-8"},
                start_new_session=True, preexec_fn=pdeathsig)
        finally:
            os.close(report_w)
            close_pinned(read + write)
            read, write = [], []
        return supervise(launcher, report_r, body, request, mode, sink, done)
    finally:
        close_pinned(read + write)
        for forwarder in forwarders:
            forwarder.close()


def supervise(launcher, report_r, body, request, mode, sink=None, done=None):
    cancelled = []

    def cancel(signum, _frame):
        cancelled.append(signum)
        try:
            launcher.send_signal(signal.SIGTERM)
        except OSError:
            pass
    signal.signal(signal.SIGTERM, cancel)
    signal.signal(signal.SIGINT, cancel)
    signal.signal(signal.SIGHUP, cancel)
    try:
        launcher.stdin.write(json.dumps(body).encode())
        launcher.stdin.close()
    except OSError:
        pass
    limit = request.get("maxOutputBytes", CHUNK)
    used = [0]
    truncated = [False]
    native_out = bytearray()

    def copy(stream, kind):
        while True:
            data = stream.read1(CHUNK) if hasattr(stream, "read1") else stream.read(CHUNK)
            if not data:
                return
            if sink is not None:
                sink(data)
                continue
            if mode == "native" and kind == b"O":
                native_out.extend(data)
                continue
            with out_lock:
                room = limit + 1 - used[0]
                keep = data[:max(room, 0)]
                used[0] += len(keep)
                if len(keep) < len(data):
                    truncated[0] = True
            if keep:
                frame(kind, keep)
    threads = [threading.Thread(target=copy, args=(launcher.stdout, b"O")),
               threading.Thread(target=copy, args=(launcher.stderr, b"E"))]
    for thread in threads:
        thread.start()
    events = []

    def read_events():
        with os.fdopen(report_r, "rb") as stream:
            for line in stream:
                try:
                    events.append(json.loads(line))
                except ValueError:
                    pass
    reader = threading.Thread(target=read_events)
    reader.start()
    # The launcher enforces timeoutMs itself; this is the hard stop if it does not.
    limit_s = request["timeoutMs"] / 1000 + 10 if mode == "exec" else 300
    try:
        code = launcher.wait(timeout=limit_s)
    except subprocess.TimeoutExpired:
        launcher.send_signal(signal.SIGTERM)
        try:
            code = launcher.wait(timeout=10)
        except subprocess.TimeoutExpired:
            launcher.kill()
            code = launcher.wait()
    reader.join()
    session = next((e for e in events if e.get("event") == "session"), None)
    if session is not None:
        # Whatever happened to the supervisor, end its closed session (exact SID and leader start
        # time), so nothing owned outlives it and no orphan keeps the output pipes open.
        subprocess.run([sys.executable, "-I", LAUNCHER, "reap"], input=json.dumps(session).encode(),
                       capture_output=True)
    for thread in threads:
        thread.join()
    result = {"code": code, "events": events, "truncated": truncated[0],
              "cancelled": bool(cancelled)}
    if mode == "native":
        text = bytes(native_out).decode("utf-8", "replace").strip()
        try:
            result["native"] = json.loads(text) if text else None
        except ValueError:
            result["native"] = None
    (done or finish)(result)


# ---- direct native work -------------------------------------------------------------------

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
            if request.get("requireRestricted"):
                launcher = load(LAUNCHER, "capybara_linux_sandbox")
                reason = launcher.probe_static(launcher.arch()[1])
                if reason:
                    raise Refused("UNAVAILABLE", reason)
            write = pin(request["writeRoots"])
            pinned += write
            read = pin([p for p in request["readRoots"] if p not in request["writeRoots"]])
            pinned += read
            roots = {"read": [{"path": e["path"], "fd": e["fd"]} for e in read],
                     "write": [{"path": e["path"], "fd": e["fd"]} for e in write]}
        elif kind == "prepare":
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

def full(argv):
    request = {"opKey": argv[0], "admitBeforeMs": int(argv[1]), "ctl": argv[2]}
    admit(request)
    if argv[3] != "--" or argv[4] != "setsid":
        raise ValueError("unexpected Full access command")
    os.execv("/usr/bin/setsid", argv[4:])


# ---- background executions ----------------------------------------------------------------

BG = "/tmp/.capybara-bg"
UUID = re.compile(r"[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}")
READ_MAX = 65536


def bg_base():
    try:
        os.mkdir(BG, 0o700)
    except FileExistsError:
        pass
    info = os.lstat(BG)
    if not stat.S_ISDIR(info.st_mode) or info.st_uid != os.getuid() or info.st_mode & 0o077:
        raise Refused("UNAVAILABLE", "The background record directory is not trusted")
    return BG


def bg_directory(execution):
    if not isinstance(execution, str) or not UUID.fullmatch(execution):
        raise ValueError("invalid execution id")
    return os.path.join(bg_base(), execution)


def write_json(path, value):
    temporary = path + ".tmp"
    with open(temporary, "w") as handle:
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
    except (OSError, ValueError, IndexError):
        return None


def write_all(fd, data):
    view = memoryview(data)
    while view:
        view = view[os.write(fd, view):]


def bg_prune(base):
    now = time.time() * 1000
    for name in os.listdir(base):
        status = read_json(os.path.join(base, name, "status.json"))
        if status and status.get("state") == "exited" and now > status.get("retainUntilMs", 0):
            shutil.rmtree(os.path.join(base, name), ignore_errors=True)


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
            write = pin(request["writeRoots"])
            pinned += write
            if not write:
                raise Refused("SCOPE_DENIED", "Restricted execution needs an existing writable root")
            roots = {"read": [], "write": [{"path": e["path"], "fd": e["fd"]} for e in write]}
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


def bg_start(request):
    admit(request)
    verify_runtime(request["expect"])
    base = bg_base()
    bg_prune(base)
    directory = bg_directory(request["executionId"])
    try:
        os.mkdir(directory, 0o700)
    except FileExistsError:
        # Started before (a lost acknowledgement): never launch twice.
        finish({"started": True, "existing": True})
        return
    try:
        out = open_output(request)
    except BaseException:
        write_json(os.path.join(directory, "status.json"), {"state": "lost", "retainUntilMs": 0})
        raise
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
            bg_supervise(request, directory, out, ready_w)
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


def bg_supervise(request, directory, out, ready_w):
    """The detached trusted supervisor: records itself before acknowledging, then runs the work."""
    spool = os.open(os.path.join(directory, "output"),
                    os.O_WRONLY | os.O_CREAT | os.O_EXCL | os.O_APPEND | os.O_CLOEXEC, 0o600)
    status_path = os.path.join(directory, "status.json")
    me = os.getpid()
    record = {"pid": me, "start": proc_start(me), "generation": generation(),
              "retainUntilMs": request["retainUntilMs"], "taskId": request["taskId"]}
    write_json(status_path, dict(record, state="running"))
    os.write(ready_w, b"R")
    os.close(ready_w)
    lock = threading.Lock()

    def sink(data):
        with lock:
            write_all(spool, data)
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
        write_json(status_path, dict(record, state="exited",
                                     exitCode=None if timed_out or refused else code,
                                     timedOut=timed_out, cancelled=bool(result.get("cancelled")),
                                     refused=refused.get("code") if refused else None))
    try:
        if request["kind"] == "device":
            full_supervise(request, sink, done)
        else:
            restricted("exec", request, sink, done)
    except Refused as error:
        done({"events": [{"event": "refused", "code": error.code}], "cancelled": False})
    except Exception:
        done({"events": [{"event": "refused", "code": "INVALID_REQUEST"}], "cancelled": False})


def full_supervise(request, sink, done):
    """Full access in the background: the existing OS user and environment, no restricted filter;
    the owned process group is ended on stop, timeout and exit."""
    env = dict(os.environ)
    env.update(request.get("env") or {})
    cancelled = []
    child = subprocess.Popen(["/bin/bash", "-c", request["command"]], cwd=request.get("cwd") or None,
                             env=env, stdin=subprocess.DEVNULL, stdout=subprocess.PIPE,
                             stderr=subprocess.STDOUT, start_new_session=True)

    def cancel(signum, _frame):
        cancelled.append(signum)
        try:
            os.killpg(child.pid, signal.SIGKILL)
        except OSError:
            pass
    signal.signal(signal.SIGTERM, cancel)
    signal.signal(signal.SIGINT, cancel)

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


def bg_lookup(request):
    """The record of an exact reference, or None (another generation, or nothing recorded)."""
    if request.get("generation") != generation():
        return None, None
    directory = bg_directory(request["executionId"])
    return directory, read_json(os.path.join(directory, "status.json"))


def bg_state(directory, status):
    if status is None:
        return {"state": "lost"}
    if status.get("state") == "running":
        if proc_start(status["pid"]) != status.get("start"):
            status = read_json(os.path.join(directory, "status.json")) or {}
            if status.get("state") != "exited":
                return {"state": "lost"}
        else:
            return {"state": "running"}
    if status.get("state") == "exited":
        return {"state": "exited", "exitCode": status.get("exitCode"),
                "timedOut": bool(status.get("timedOut"))}
    return {"state": "lost"}


def bg_status(request):
    directory, status = bg_lookup(request)
    return bg_state(directory, status)


def bg_expired(status):
    return status is not None and time.time() * 1000 > status.get("retainUntilMs", 0) \
        and status.get("state") == "exited"


def bg_output(request, tail):
    directory, status = bg_lookup(request)
    if directory is None:
        if tail:
            return {"unavailable": "lost"}
        raise Refused("SCOPE_DENIED", "The reference names another instance generation")
    if bg_expired(status):
        return {"unavailable": "expired"}
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
            # Start on a whole UTF-8 character.
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


def bg_stop(request):
    directory, status = bg_lookup(request)
    if directory is None:
        return {"outcome": "lost"}
    return stop_execution(directory, status, request.get("graceMs", 0))


def stop_execution(directory, status, grace_ms):
    """Atomically claims the terminal outcome (stop.json); a retry returns the same outcome."""
    stop_path = os.path.join(directory, "stop.json")
    prior = read_json(stop_path)
    if prior is not None:
        return prior
    state = bg_state(directory, status)
    if state["state"] == "running":
        pid = status["pid"]
        try:
            os.kill(pid, signal.SIGTERM)
        except OSError:
            pass
        deadline = time.monotonic() + grace_ms / 1000 + 15
        while time.monotonic() < deadline and proc_start(pid) == status.get("start"):
            time.sleep(0.02)
        if proc_start(pid) == status.get("start"):
            # The supervisor did not finish: SIGKILL; its launcher's death signal ends the tree.
            try:
                os.kill(pid, signal.SIGKILL)
            except OSError:
                pass
        final = read_json(os.path.join(directory, "status.json")) or {}
        if final.get("state") == "exited" and not final.get("cancelled"):
            outcome = {"outcome": "already-exited", "exitCode": final.get("exitCode"),
                       "timedOut": bool(final.get("timedOut"))}
        else:
            outcome = {"outcome": "stopped"}
    elif state["state"] == "exited":
        outcome = {"outcome": "already-exited", "exitCode": state["exitCode"],
                   "timedOut": state["timedOut"]}
    else:
        outcome = {"outcome": "lost"}
    try:
        write_new(stop_path, outcome, 0o600)
    except FileExistsError:
        return read_json(stop_path) or outcome
    return outcome


# ---- exact cancellation -------------------------------------------------------------------

def agents(ctl=None, uuid=None):
    """This agent's own processes running one exact operation, by their argv (never stdout)."""
    found = []
    for entry in os.listdir("/proc"):
        if not entry.isdigit():
            continue
        try:
            with open("/proc/%s/cmdline" % entry, "rb") as handle:
                args = handle.read().split(b"\0")
        except OSError:
            continue
        if (len(args) < 6 or args[2] != os.fsencode(os.path.abspath(__file__))
                or args[3] not in (b"exec", b"native") or args[4] != MARKER.encode()):
            continue
        target = os.fsdecode(args[5])
        if (ctl is not None and target == ctl) or (
                uuid is not None and target.startswith("/tmp/.capybara-exec-")
                and target.endswith("-" + uuid)):
            found.append(int(entry))
    return found


def cancel(ctl=None, uuid=None):
    """SIGTERM lets the launcher end its whole tree; SIGKILL only if that does not happen."""
    if ctl is not None:
        try:
            open(ctl + ".kill", "a").close()
        except OSError:
            pass
    for pid in agents(ctl, uuid):
        try:
            os.kill(pid, signal.SIGTERM)
        except OSError:
            pass
    deadline = time.monotonic() + 15
    while agents(ctl, uuid) and time.monotonic() < deadline:
        time.sleep(0.02)
    for pid in agents(ctl, uuid):
        try:
            os.kill(pid, signal.SIGKILL)
        except OSError:
            pass
    while agents(ctl, uuid) and time.monotonic() < deadline + 5:
        time.sleep(0.02)
    if uuid is not None and UUID.fullmatch(uuid) and os.path.isdir(os.path.join(BG, uuid)):
        directory = os.path.join(BG, uuid)
        stop_execution(directory, read_json(os.path.join(directory, "status.json")), 0)
    return 0


# ---- durable records (root) ---------------------------------------------------------------

def generation():
    with open("/proc/sys/kernel/random/boot_id") as handle:
        boot = handle.read().strip()
    with open("/proc/1/stat") as handle:
        data = handle.read()
    started = data[data.rindex(")") + 2:].split()[19]
    return hashlib.sha256(("%s/%s" % (boot, started)).encode()).hexdigest()[:24]


def records():
    try:
        os.mkdir(OPS, 0o711)
    except FileExistsError:
        pass
    info = os.lstat(OPS)
    if not stat.S_ISDIR(info.st_mode) or info.st_uid != 0 or info.st_mode & 0o7777 != 0o711:
        raise Refused("UNAVAILABLE", "The operation record directory is not trusted")
    now = time.time() * 1000
    for name in os.listdir(OPS):
        path = os.path.join(OPS, name)
        try:
            with open(path) as handle:
                expires = json.load(handle).get("expiresAtMs", 0)
            if now > expires + 3600_000:
                os.unlink(path)
        except (OSError, ValueError):
            pass


def write_new(path, record, mode):
    fd = os.open(path, os.O_WRONLY | os.O_CREAT | os.O_EXCL | os.O_NOFOLLOW, mode)
    with os.fdopen(fd, "w") as handle:
        json.dump(record, handle)


def consume(request):
    records()
    key = request["opKey"]
    if os.path.exists(os.path.join(OPS, key + ".revoked")):
        return {"state": "revoked"}
    path = os.path.join(OPS, key + ".json")
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
    if (existing.get("generation"), existing.get("method"), existing.get("inputHash")) != (
            record["generation"], record["method"], record["inputHash"]):
        return {"state": "mismatch"}
    return {"state": "duplicate", "record": existing}


def revoke(request):
    records()
    try:
        write_new(os.path.join(OPS, request["opKey"] + ".revoked"),
                  {"expiresAtMs": request["expiresAtMs"]}, 0o644)
    except FileExistsError:
        pass
    return {"state": "revoked"}


# ---- entry --------------------------------------------------------------------------------

def main():
    command = sys.argv[1] if len(sys.argv) > 1 else ""
    try:
        if command == "full":
            try:
                full(sys.argv[2:])
            except Refused as error:
                # Nothing ran: the only output is this refusal frame, and the exit code is 125.
                finish({"events": [{"event": "refused", "code": error.code,
                                    "message": str(error)}]})
            return 125
        if command == "cancel":
            if sys.argv[2] == "--uuid":
                return cancel(uuid=sys.argv[3])
            return cancel(ctl=sys.argv[2])
        if command == "probe":
            done = subprocess.run([sys.executable, "-I", LAUNCHER, "probe"], capture_output=True)
            finish({"probe": json.loads(done.stdout)})
            return 0
        request = read_request()
        if command in ("exec", "native"):
            restricted(command, request)
        elif command == "direct":
            direct(request)
        elif command == "consume":
            finish(consume(request))
        elif command == "revoke":
            finish(revoke(request))
        elif command == "bg-start":
            bg_start(request)
        elif command == "bg-status":
            finish(bg_status(request))
        elif command == "bg-tail":
            finish(bg_output(request, True))
        elif command == "bg-read":
            finish(bg_output(request, False))
        elif command == "bg-stop":
            finish(bg_stop(request))
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
