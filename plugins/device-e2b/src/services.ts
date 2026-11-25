// Device services (browser use spec §5–6), shared by device-docker and device-e2b: this file is
// identical in both plugins (tools/checks/test/shared-device-services.test.ts compares them byte
// for byte; edit one and copy it to the other).
import { createHash } from "node:crypto";
import {
  DEVICE_SERVICE_ID_RE,
  DEVICE_SERVICE_MAX_MESSAGE,
  type DeviceServiceSpec,
  type DeviceServiceStatus,
  type DeviceStream,
  encodeServiceMessage,
  ServiceMessageDecoder,
} from "@capybara-hq/plugin-sdk";

/**
 * The user every device service, its manager and its socket relay run as (the image's
 * `capybara-svc`, uid and gid {@link SERVICE_UID}: not 1001, which E2B gives its own `user`),
 * never the sandbox user agent commands run as (capybara-hq/plugins#210): a service's state (a
 * browser profile with the cookies of sessions the person logged into), its socket and its processes are out of an agent command's reach, and
 * the service cannot touch the agent's files beyond what their modes allow everyone.
 */
export const SERVICE_USER = "capybara-svc";
/** The uid and gid of {@link SERVICE_USER}. */
export const SERVICE_UID = 1100;

/**
 * Where a device's service state directories live: persistent with the device's files but outside
 * the workspace, so no project root, Glob / Grep, share or delivery ever reaches a service's state
 * (a browser profile's cookies). Docker: the device's own `<name>-svc` volume mounted here; E2B:
 * a directory on the VM's disk. Owned by {@link SERVICE_USER}, 0700 (the image makes it; device-e2b
 * makes it as root on a VM whose template predates it).
 */
export const SERVICE_STATE_ROOT = "/var/lib/capybara/svc";

/**
 * Where a service's runtime files live (pid record, socket, lock, log): owned by
 * {@link SERVICE_USER}, 0700, where the sandbox user cannot make it first (Docker: a tmpfs mounted
 * there with that owner; E2B: made by root under the root-owned /run). Nothing of a process
 * outlives the instance that ran it (Docker: a tmpfs; E2B: the record is checked against the boot
 * id and the process start time as well).
 */
export const SERVICE_RUN_ROOT = "/run/capybara-svc";

/**
 * The browsers the image ships (Playwright's full Chromium build, pinned to the browser plugin's
 * playwright-core): root-owned and read only for every service, which gets it as
 * PLAYWRIGHT_BROWSERS_PATH, so a service never runs a browser it or an agent command could
 * replace (capybara-hq/plugins#209).
 */
export const SERVICE_BROWSERS_PATH = "/opt/capybara-browsers";

/**
 * Where the device's workspace downloads go (`<workspace>/downloads`): made by the provider as the
 * sandbox user, 2777, so a service (another user) can save files there and they stay the agent's
 * group (setgid); a service writes nothing else in the workspace.
 */
export const SERVICE_DOWNLOADS_DIR = "/workspace/downloads";

/**
 * Makes {@link SERVICE_DOWNLOADS_DIR} as the sandbox user before a service starts (`$1`): a
 * directory, mode 2777, unless a link stands there (the service refuses a link itself). Always
 * exits 0: a failure only means the service cannot save downloads, which it reports itself.
 */
export const DOWNLOADS_DIR_SCRIPT =
  '[ -L "$1" ] && exit 0; mkdir -p -- "$1" 2>/dev/null && chmod 2777 -- "$1" 2>/dev/null; exit 0';

/** The answer when the image or VM predates isolated device services. */
export const SERVICE_IMAGE_TOO_OLD =
  "This device's image predates isolated device services (no capybara-svc user, or /var/lib/capybara/svc or /run/capybara-svc is not owned by it). The instance must be recreated on the current image: that happens after a period without use, or delete the device and create it again.";

/** The state directory of a service: absolute, stable per device and id, known before start. */
export function serviceStateDir(name: string): string {
  checkServiceName(name);
  return `${SERVICE_STATE_ROOT}/${name}`;
}

/** The unix socket a service listens on (`CAPYBARA_SERVICE_SOCKET`). */
export function serviceSocketPath(name: string): string {
  checkServiceName(name);
  return `${SERVICE_RUN_ROOT}/${name}/sock`;
}

/** Refuses anything but a service id (`<extension>.<name>`: the kernel namespaces every name). */
export function checkServiceName(name: string): void {
  if (!DEVICE_SERVICE_ID_RE.test(name)) {
    throw new Error(`invalid device service id: ${JSON.stringify(name)}`);
  }
}

/** The interpreter of the service manager (system path, never the image's writable PATH). */
export const MANAGER_PYTHON = "/usr/bin/python3";

/** The node binary every service and the relay run on (the published image's Node 22). */
export const SERVICE_NODE = "/usr/local/bin/node";

/**
 * The service manager, run as {@link SERVICE_USER} by the provider: `python3 -I -c <script> <op>
 * <id>` with `op` one of `status`, `ensure` (request on stdin: a 4-byte big-endian length, then
 * JSON) and `stop`. It answers one JSON line: a status `{state, startedAt, stateDir}`, or
 * `{error}` with exit code 1.
 *
 * - `ensure` takes the service's lock (flock in its run directory), keeps a running service as it
 *   is, answers `stopped` for `ifRunning`; otherwise writes the files into the state directory
 *   without following any link (every directory opened `O_NOFOLLOW` below the state root, each
 *   file opened `O_NOFOLLOW | O_NONBLOCK` relative to its directory and accepted only when it is a
 *   regular file, so a planted FIFO cannot block it), starts `node <stateDir>/<entry> <args>`
 *   in a new session with the state directory as its working directory, and waits until the
 *   service listens on its socket (or exits, reported with the tail of its log).
 * - Files go digest first (R27): a start request carries the files' digest and paths; the manager
 *   starts from the files in the state directory when its `.files-digest` record matches and
 *   those files hash to the digest, and otherwise answers `{"filesNeeded": true}`; the provider
 *   then sends the files, which the manager checks against the digest, writes, and records the
 *   digest for (temp file and rename, the old record removed first).
 * - A pid record counts only while its process is alive with the recorded start time on the
 *   recorded boot: after a suspend, a restart or a pid reuse it reads as stopped.
 * - The service gets the manager's environment (the instance's, with its egress proxy variables)
 *   less every variable naming a path in the workspace (the agent's caches: a service never runs
 *   or trusts what an agent command can write), its own `HOME` and XDG directories in its state
 *   directory, `TMPDIR` in its run directory, `PLAYWRIGHT_BROWSERS_PATH` set to the image's
 *   read-only browsers ({@link SERVICE_BROWSERS_PATH}), then the spec's `env`, `PATH` set to
 *   root-owned directories and the socket and state variables (`CAPYBARA_SERVICE_WORKSPACE` too:
 *   the device's workspace root). It runs with umask 002, so what it saves in the workspace
 *   downloads stays writable for the agent's group. Nothing restarts a service that exited: the
 *   next `ensure` (reviewed again by the kernel) does.
 * - A state root or run root that is missing or not {@link SERVICE_USER}'s, private (an image
 *   before isolated device services) answers {@link SERVICE_IMAGE_TOO_OLD} on a start; a status, an
 *   `ifRunning` ensure or a stop there answers stopped (E2B makes the run root only before a start:
 *   its /run is a fresh tmpfs at every boot, so a new VM has none until then).
 * - `stop` sends SIGTERM to the service's process group, waits up to 5 s, then SIGKILLs every
 *   process left in its session.
 */
export const SERVICE_MANAGER_SCRIPT = `import base64, fcntl, hashlib, json, os, re, signal, stat, sys, time
NAME_RE = re.compile(r"^[a-z][a-z0-9-]{1,40}\\.[a-z][a-z0-9-]{0,31}$")
KEY_RE = re.compile(r"^[A-Za-z_][A-Za-z0-9_]*$")
STATE = ("/var/lib/capybara/svc", ())
TOO_OLD = "This device's image predates isolated device services (no capybara-svc user, or /var/lib/capybara/svc or /run/capybara-svc is not owned by it). The instance must be recreated on the current image: that happens after a period without use, or delete the device and create it again."
RUN = "/run/capybara-svc"
WORKSPACE = "/workspace"
BROWSERS = "/opt/capybara-browsers"
DIGEST_FILE = ".files-digest"
DIGEST_RE = re.compile(r"^[0-9a-f]{64}$")
NODE = "/usr/local/bin/node"
PATH = "/usr/local/bin:/usr/bin:/bin"
DIR = os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW | os.O_CLOEXEC
FILE = os.O_NOFOLLOW | os.O_CLOEXEC | os.O_NONBLOCK
READY_S = 30
STOP_S = 5

def answer(obj, code=0):
    sys.stdout.write(json.dumps(obj) + "\\n")
    sys.stdout.flush()
    sys.exit(code)

def fail(msg):
    answer({"error": msg}, 1)

def boot_id():
    try:
        with open("/proc/sys/kernel/random/boot_id") as f:
            return f.read().strip()
    except OSError:
        return ""

def proc_stat(pid):
    try:
        with open("/proc/%d/stat" % pid, "rb") as f:
            s = f.read()
    except OSError:
        return None
    return s[s.rindex(b")") + 2:].split()

def start_ticks(pid):
    st = proc_stat(pid)
    if st is None or st[0] in (b"Z", b"X"):
        return None
    return st[19].decode()

def read_record(rfd):
    if rfd is None:
        return None
    try:
        fd = open_reg("pid", os.O_RDONLY, rfd)
    except OSError:
        return None
    with os.fdopen(fd) as f:
        try:
            rec = json.load(f)
        except ValueError:
            return None
    if not isinstance(rec, dict) or not isinstance(rec.get("pid"), int):
        return None
    if rec.get("boot") != boot_id() or start_ticks(rec["pid"]) != rec.get("start"):
        return None
    return rec

def status(name, rec):
    state_dir = "%s/%s" % (STATE[0], name)
    if rec is None:
        return {"name": name, "state": "stopped", "startedAt": None, "stateDir": state_dir}
    return {"name": name, "state": "running", "startedAt": rec["at"], "stateDir": state_dir}

def private_dir(path):
    # a directory of this user that nobody else may enter, opened without following a link; None
    # when it is missing or anything else
    try:
        fd = os.open(path, DIR)
    except OSError:
        return None
    st = os.fstat(fd)
    if st.st_uid != os.getuid() or stat.S_IMODE(st.st_mode) & 0o077:
        os.close(fd)
        return None
    return fd

def rundir(name, create):
    # the run root is never made here: the image or the provider makes it, owned by this user
    base = private_dir(RUN)
    if base is None:
        if create:
            fail(TOO_OLD)
        return None
    try:
        return opendirs_at(base, name, create)
    finally:
        os.close(base)

def opendirs_at(fd, name, create):
    try:
        return os.open(name, DIR, dir_fd=fd)
    except FileNotFoundError:
        if not create:
            return None
        try:
            os.mkdir(name, 0o700, dir_fd=fd)
        except FileExistsError:
            pass
        return os.open(name, DIR, dir_fd=fd)

def lock(rfd):
    fd = open_reg("lock", os.O_WRONLY | os.O_CREAT, rfd)
    end = time.monotonic() + 60
    while True:
        try:
            fcntl.flock(fd, fcntl.LOCK_EX | fcntl.LOCK_NB)
            return fd
        except BlockingIOError:
            if time.monotonic() > end:
                fail("the service is busy: another start or stop holds its lock")
            time.sleep(0.05)

def unlink(rfd, name):
    try:
        os.unlink(name, dir_fd=rfd)
    except FileNotFoundError:
        pass

def open_reg(name, flags, dir_fd, mode=0o600):
    # never blocks on a planted FIFO, never follows a link, and only a regular file is accepted
    fd = os.open(name, flags | FILE, mode, dir_fd=dir_fd)
    if not stat.S_ISREG(os.fstat(fd).st_mode):
        os.close(fd)
        raise OSError(22, "not a regular file", name)
    return fd

def session_pids(sid):
    out = []
    for e in os.listdir("/proc"):
        if not e.isdigit():
            continue
        st = proc_stat(int(e))
        if st is not None and st[3] == str(sid).encode() and st[0] not in (b"Z", b"X"):
            out.append(int(e))
    return out

def kill(pid, sig):
    try:
        os.kill(pid, sig)
    except (ProcessLookupError, PermissionError):
        pass

def kill_relays(name):
    # relays left connected to this service's socket (a provider that lost one before it knew
    # its pid): their command line names the relay and ends with the socket path
    sock = ("%s/%s/sock" % (RUN, name)).encode()
    for e in os.listdir("/proc"):
        if not e.isdigit() or int(e) == os.getpid():
            continue
        try:
            with open("/proc/%s/cmdline" % e, "rb") as f:
                argv = f.read().split(b"\\0")
        except OSError:
            continue
        if argv and argv[-1] == b"":
            argv = argv[:-1]
        if len(argv) >= 2 and argv[-1] == sock and any(b"capybara-socket-relay" in a for a in argv):
            kill(int(e), signal.SIGKILL)

def stop_record(rec):
    pid = rec["pid"]
    kill(-pid, signal.SIGTERM)
    end = time.monotonic() + STOP_S
    while time.monotonic() < end and start_ticks(pid) == rec["start"]:
        time.sleep(0.05)
    for _ in range(3):
        left = session_pids(pid)
        if start_ticks(pid) == rec["start"]:
            left.append(pid)
        if not left:
            break
        for p in left:
            kill(p, signal.SIGKILL)
        time.sleep(0.05)

def read_request():
    head = sys.stdin.buffer.read(4)
    if len(head) != 4:
        fail("missing request")
    n = int.from_bytes(head, "big")
    data = bytearray()
    while len(data) < n:
        chunk = sys.stdin.buffer.read(n - len(data))
        if not chunk:
            fail("truncated request")
        data += chunk
    return json.loads(bytes(data))

def segments(rel):
    parts = rel.split("/")
    if rel.startswith("/") or "\\\\" in rel or "\\0" in rel or any(p in ("", ".", "..") for p in parts):
        fail("invalid service file path %s" % json.dumps(rel))
    return parts

def write_files(sfd, files):
    # files: path -> bytes, decoded once by the caller
    for rel, data in sorted(files.items()):
        parts = segments(rel)
        try:
            fd = os.dup(sfd)
            for p in parts[:-1]:
                nfd = opendirs_at(fd, p, True)
                os.close(fd)
                fd = nfd
            out = open_reg(parts[-1], os.O_WRONLY | os.O_CREAT | os.O_TRUNC, fd)
            os.close(fd)
        except OSError as e:
            fail("cannot write service file %s: %s (a link, a non-directory or a special file is in the way)" % (json.dumps(rel), e.strerror))
        with os.fdopen(out, "wb") as f:
            f.write(data)

def files_digest(items):
    # sha256 over (path, bytes) in the given order: path, NUL, byte length, NUL, bytes
    h = hashlib.sha256()
    for rel, data in items:
        h.update(rel.encode("utf-8") + b"\\0" + str(len(data)).encode() + b"\\0")
        h.update(data)
    return h.hexdigest()

def read_stored(sfd, rel):
    parts = segments(rel)
    fd = os.dup(sfd)
    try:
        for p in parts[:-1]:
            nfd = os.open(p, DIR, dir_fd=fd)
            os.close(fd)
            fd = nfd
        f = open_reg(parts[-1], os.O_RDONLY, fd)
    finally:
        os.close(fd)
    with os.fdopen(f, "rb") as fh:
        return fh.read()

def stored_matches(sfd, paths, digest):
    # a hit needs the recorded digest and the files on disk hashing to it (a file changed in the
    # state directory since is a miss)
    try:
        if read_stored(sfd, DIGEST_FILE).decode("ascii").strip() != digest:
            return False
        return files_digest([(rel, read_stored(sfd, rel)) for rel in paths]) == digest
    except (OSError, UnicodeDecodeError):
        return False

def record_digest(sfd, digest):
    tmp = DIGEST_FILE + ".tmp"
    unlink(sfd, tmp)
    fd = open_reg(tmp, os.O_WRONLY | os.O_CREAT | os.O_EXCL, sfd)
    with os.fdopen(fd, "w") as f:
        f.write(digest + "\\n")
    os.rename(tmp, DIGEST_FILE, src_dir_fd=sfd, dst_dir_fd=sfd)

def log_tail(rfd):
    try:
        fd = open_reg("log", os.O_RDONLY, rfd)
    except OSError:
        return ""
    with os.fdopen(fd, "rb") as f:
        f.seek(0, 2)
        size = f.tell()
        f.seek(max(0, size - 2000))
        return f.read().decode("utf-8", "replace").strip()

def names_workspace(value):
    # a variable naming a path in the workspace (alone, or in a list such as PATH)
    return any(p == WORKSPACE or p.startswith(WORKSPACE + "/") for p in value.split(":"))

def ensure(name, req):
    if req.get("ifRunning") is True:
        # reads only: on a VM whose run root is not made yet (E2B mounts a fresh /run at boot, the
        # provider makes it before a start) nothing runs, so the service is stopped
        rfd = rundir(name, False)
        answer(status(name, read_record(rfd)))
    rfd = rundir(name, True)
    st = os.fstat(rfd)
    if st.st_uid != os.getuid() or stat.S_IMODE(st.st_mode) & 0o077:
        fail("the service run directory is not private to the service user")
    lock(rfd)
    rec = read_record(rfd)
    if rec is not None or req.get("ifRunning") is True:
        answer(status(name, rec))
    entry, args, env, files = req.get("entry"), req.get("args"), req.get("env") or {}, req.get("files")
    digest, paths = req.get("digest"), req.get("paths")
    if not isinstance(digest, str) or not DIGEST_RE.match(digest):
        fail("invalid service files digest")
    if not isinstance(paths, list) or not all(isinstance(p, str) for p in paths) or len(set(paths)) != len(paths):
        fail("invalid service file list")
    for rel in paths:
        segments(rel)
    if DIGEST_FILE in paths or (DIGEST_FILE + ".tmp") in paths:
        fail("%s is reserved in a service's state directory" % DIGEST_FILE)
    if not isinstance(entry, str) or entry not in paths:
        fail("the service entry must be one of its files")
    if files is not None and (not isinstance(files, dict) or set(files) != set(paths)):
        fail("the service files do not match their list")
    if not isinstance(args, list) or not all(isinstance(a, str) and "\\0" not in a for a in args):
        fail("invalid service arguments")
    if not isinstance(env, dict) or not all(isinstance(k, str) and KEY_RE.match(k) and isinstance(v, str) and "\\0" not in v for k, v in env.items()):
        fail("invalid service environment")
    root = private_dir(STATE[0])
    if root is None:
        fail(TOO_OLD)
    try:
        sfd = opendirs_at(root, name, True)
    except OSError as e:
        fail("cannot open the service state directory: %s (a link or a non-directory is in the way)" % e.strerror)
    os.close(root)
    if files is None:
        # digest first: start from the files already there, or ask for them
        if not stored_matches(sfd, paths, digest):
            answer({"filesNeeded": True})
    else:
        decoded = {rel: base64.b64decode(files[rel]) for rel in paths}
        if files_digest([(rel, decoded[rel]) for rel in paths]) != digest:
            fail("the service files do not match their digest")
        # no stale record may vouch for a half-written set
        unlink(sfd, DIGEST_FILE)
        write_files(sfd, decoded)
        record_digest(sfd, digest)
    state_dir = status(name, None)["stateDir"]
    sock = "%s/%s/sock" % (RUN, name)
    tmp_fd = opendirs_at(rfd, "tmp", True)
    os.close(tmp_fd)
    unlink(rfd, "sock")
    unlink(rfd, "pid")
    unlink(rfd, "log")
    logfd = open_reg("log", os.O_WRONLY | os.O_CREAT | os.O_TRUNC, rfd)
    # the service's output must not be non-blocking
    os.set_blocking(logfd, True)
    # nothing the agent can write: no variable naming a workspace path (its caches, its PATH)
    penv = {k: v for k, v in os.environ.items() if not k.startswith("CAPYBARA_") and not names_workspace(v)}
    penv.update({"HOME": state_dir, "XDG_CACHE_HOME": state_dir + "/.cache",
                 "XDG_CONFIG_HOME": state_dir + "/.config", "XDG_DATA_HOME": state_dir + "/.local/share",
                 "TMPDIR": "%s/%s/tmp" % (RUN, name), "PLAYWRIGHT_BROWSERS_PATH": BROWSERS})
    penv.update(env)
    penv.update({"PATH": PATH, "CAPYBARA_SERVICE_SOCKET": sock, "CAPYBARA_SERVICE_STATE": state_dir,
                 "CAPYBARA_SERVICE_WORKSPACE": WORKSPACE})
    argv = [NODE, "%s/%s" % (state_dir, entry)] + args
    at = time.time()
    pid = os.fork()
    if pid == 0:
        try:
            os.setsid()
            os.umask(0o002)
            os.fchdir(sfd)
            null = os.open("/dev/null", os.O_RDONLY)
            os.dup2(null, 0)
            os.dup2(logfd, 1)
            os.dup2(logfd, 2)
            os.execve(NODE, argv, penv)
        except BaseException as e:
            os.write(2, ("cannot start the service: %s\\n" % e).encode())
        os._exit(127)
    rec = {"pid": pid, "start": start_ticks(pid), "boot": boot_id(),
           "at": time.strftime("%Y-%m-%dT%H:%M:%S", time.gmtime(at)) + ".%03dZ" % (int(at * 1000) % 1000)}
    tmp = "pid.%d" % pid
    fd = open_reg(tmp, os.O_WRONLY | os.O_CREAT | os.O_EXCL, rfd)
    os.set_blocking(fd, True)
    with os.fdopen(fd, "w") as f:
        json.dump(rec, f)
    os.rename(tmp, "pid", src_dir_fd=rfd, dst_dir_fd=rfd)
    end = time.monotonic() + READY_S
    while True:
        done, _ = os.waitpid(pid, os.WNOHANG)
        if done != 0:
            unlink(rfd, "pid")
            fail("the service exited before it listened on its socket: %s" % (log_tail(rfd) or "no output"))
        try:
            if stat.S_ISSOCK(os.stat("sock", dir_fd=rfd, follow_symlinks=False).st_mode):
                answer(status(name, rec))
        except FileNotFoundError:
            pass
        if time.monotonic() > end:
            stop_record(rec)
            unlink(rfd, "pid")
            fail("the service did not listen on its socket within %d s: %s" % (READY_S, log_tail(rfd) or "no output"))
        time.sleep(0.05)

def stop(name):
    rfd = rundir(name, False)
    if rfd is None:
        answer(status(name, None))
    lock(rfd)
    rec = read_record(rfd)
    if rec is not None:
        stop_record(rec)
    kill_relays(name)
    unlink(rfd, "pid")
    unlink(rfd, "sock")
    answer(status(name, None))

def main():
    if len(sys.argv) != 3 or not NAME_RE.match(sys.argv[2]):
        fail("usage: manager status|ensure|stop <name>")
    op, name = sys.argv[1], sys.argv[2]
    if op == "status":
        rfd = rundir(name, False)
        answer(status(name, read_record(rfd)))
    if op == "ensure":
        ensure(name, read_request())
    if op == "stop":
        stop(name)
    fail("unknown op %s" % json.dumps(op))

try:
    main()
except OSError as e:
    fail("service manager: %s" % e)
`;

/** The manager's command line for one operation. */
export function managerArgv(op: "status" | "ensure" | "stop", name: string): string[] {
  checkServiceName(name);
  return [MANAGER_PYTHON, "-I", "-c", SERVICE_MANAGER_SCRIPT, op, name];
}

/**
 * The digest of a spec's files (R27): sha256 over the files in path order, each as its path,
 * NUL, its byte length in decimal, NUL, its bytes. `paths` is that order; the manager hashes the
 * files it holds in the same order.
 */
export function serviceFilesDigest(files: Record<string, Uint8Array>): {
  digest: string;
  paths: string[];
} {
  const paths = Object.keys(files).sort();
  const h = createHash("sha256");
  for (const p of paths) {
    const data = files[p] as Uint8Array;
    h.update(Buffer.from(`${p}\0${String(data.byteLength)}\0`, "utf8"));
    h.update(data);
  }
  return { digest: h.digest("hex"), paths };
}

/**
 * The `ensure` request on the manager's stdin. With `ifRunning` it carries nothing of the spec:
 * the manager never starts anything then. Otherwise it carries the entry, arguments,
 * environment, the files' digest and their paths, and the files themselves only `withFiles`: a
 * start asks with the digest first, and the manager starts from the files already in the state
 * directory when they hash to it, or answers {@link isFilesNeeded} (then the provider sends them).
 */
export function managerRequest(
  spec: DeviceServiceSpec,
  o: { ifRunning?: boolean; withFiles?: boolean } = {},
): Uint8Array {
  checkServiceName(spec.name);
  let body: Record<string, unknown>;
  if (o.ifRunning) body = { ifRunning: true };
  else {
    const { digest, paths } = serviceFilesDigest(spec.files);
    body = {
      entry: spec.entry,
      args: spec.args,
      env: spec.env ?? {},
      digest,
      paths,
      ...(o.withFiles && {
        files: Object.fromEntries(
          paths.map((k) => [k, Buffer.from(spec.files[k] as Uint8Array).toString("base64")]),
        ),
      }),
    };
  }
  const json = Buffer.from(JSON.stringify(body), "utf8");
  const out = Buffer.alloc(4 + json.byteLength);
  out.writeUInt32BE(json.byteLength, 0);
  json.copy(out, 4);
  return out;
}

/** The manager answered a digest-only start with "send the files" (a successful exit). */
export function isFilesNeeded(r: { exitCode: number | null; stdout: string }): boolean {
  if (r.exitCode !== 0) return false;
  const line = r.stdout.trim().split("\n").pop() ?? "";
  try {
    return (JSON.parse(line) as { filesNeeded?: unknown }).filesNeeded === true;
  } catch {
    return false;
  }
}

/** Parses the manager's answer; `{error}`, a failed exit or an unreadable answer throws. */
export function parseManagerReply(
  name: string,
  r: { exitCode: number | null; stdout: string; stderr: string; timedOut?: boolean },
): DeviceServiceStatus {
  const line = r.stdout.trim().split("\n").pop() ?? "";
  let reply: Record<string, unknown> | null = null;
  try {
    reply = JSON.parse(line) as Record<string, unknown>;
  } catch {
    reply = null;
  }
  if (r.exitCode !== 0 || reply === null || typeof reply.error === "string") {
    const why =
      typeof reply?.error === "string"
        ? reply.error
        : r.timedOut
          ? "timed out"
          : r.exitCode === 127
            ? "python3 is missing from the device image"
            : r.stderr.trim().slice(0, 500) || `exit code ${String(r.exitCode)}`;
    throw new Error(`device service ${name}: ${why}`);
  }
  const { state, startedAt, stateDir } = reply;
  if (
    reply.name !== name ||
    (state !== "running" && state !== "stopped") ||
    (startedAt !== null && typeof startedAt !== "string") ||
    typeof stateDir !== "string"
  ) {
    throw new Error(`device service ${name}: the service manager answered an unreadable status`);
  }
  return { name, state, startedAt, stateDir };
}

/**
 * The socket relay (`capybara-socket-relay <socket>`): connects to a service's unix socket, says
 * `ready` on stderr once connected, then copies stdin to the socket and the socket to stdout byte
 * for byte (the provider and the service speak the framed service protocol through it). It exits
 * when either side closes: the socket's end ends stdout; the end of stdin (the provider went away)
 * destroys the connection. A failed connect (the service is not running) exits 3 with the reason on
 * stderr. Both providers run it inline ({@link relayArgv}), so it works on every instance, whatever
 * image or template it was made from.
 */
export const SOCKET_RELAY_SOURCE = `// capybara-socket-relay <socket>: one connection to a device service's unix socket, relayed over
// stdin / stdout byte for byte (device-docker / device-e2b src/services.ts, SOCKET_RELAY_SOURCE).
import { connect } from "node:net";

const path = process.argv[process.argv.length - 1];
const sock = connect(path);
let connected = false;
sock.on("connect", () => {
  connected = true;
  process.stderr.write("ready\\n");
  process.stdin.on("data", (chunk) => {
    if (!sock.write(chunk)) process.stdin.pause();
  });
  sock.on("drain", () => process.stdin.resume());
  process.stdin.on("end", () => sock.destroy());
  process.stdin.on("error", () => sock.destroy());
  sock.pipe(process.stdout);
});
sock.on("error", (e) => {
  if (!connected) {
    process.stderr.write(\`capybara-socket-relay: cannot connect: \${e.code ?? e.message}\\n\`);
    process.exit(3);
  }
});
sock.on("close", () => {
  process.stdout.end(() => process.exit(0));
});
process.stdout.on("error", () => process.exit(0));
`;

/** The relay's command line for one service: inline, on the image's Node. */
export function relayArgv(name: string): [string, ...string[]] {
  return [SERVICE_NODE, "--input-type=module", "-e", SOCKET_RELAY_SOURCE, serviceSocketPath(name)];
}

/** What a provider's transport gives {@link openRelay}: one running relay process. */
export interface RelayTransport {
  /** Writes bytes to the relay's stdin; resolves once they are handed to the transport. */
  write(bytes: Uint8Array): Promise<void>;
  /** Ends the relay (idempotent): the connection to the service closes with it. */
  close(): void;
  /** Optional backpressure on the relay's stdout (Docker pauses its socket). */
  pause?(): void;
  resume?(): void;
}

/** The provider's side of an open relay: feed it the relay's output and its end. */
export interface RelaySink {
  stdout(chunk: Uint8Array): void;
  stderr(chunk: Uint8Array): void;
  /** The relay process ended (or its transport broke); `why` when it was an error. */
  ended(why?: string): void;
}

/** Bytes of unread messages above which the relay's output is paused (resumed at half). */
export const RELAY_HIGH_WATER_BYTES = 8 * 1024 * 1024;
/**
 * Bytes of unread messages at which a stream whose transport cannot pause (E2B) is closed: its
 * reader fell behind, and queueing more would only grow the provider's memory.
 */
export const RELAY_HARD_CAP_BYTES = 24 * 1024 * 1024;
/** The close reason when a reader fell behind the hard cap. */
export const RELAY_FELL_BEHIND = "the viewer fell behind; reopen the view";

/**
 * A {@link DeviceStream} over a relay: `ready` resolves once the relay connected to the service's
 * socket (it rejects with the relay's reason, `not running`, when it could not). Messages are the
 * service's framed messages; `send` frames one and resolves once the transport took it.
 */
export function relayStream(
  name: string,
  io: RelayTransport,
): { sink: RelaySink; ready: Promise<void>; stream: DeviceStream } {
  const decoder = new ServiceMessageDecoder();
  const queue: Uint8Array[] = [];
  let waiting: ((r: IteratorResult<Uint8Array>) => void) | null = null;
  let paused = false;
  let queuedBytes = 0;
  let isReady = false;
  let stderr = "";
  let reason: string | null = null;
  let resolveClosed!: (v: { reason: string }) => void;
  const closed = new Promise<{ reason: string }>((r) => {
    resolveClosed = r;
  });
  let resolveReady!: () => void;
  let rejectReady!: (e: Error) => void;
  const ready = new Promise<void>((res, rej) => {
    resolveReady = res;
    rejectReady = rej;
  });
  // never an unhandled rejection when nobody awaits it (the stream closed later)
  ready.catch(() => undefined);

  const finish = (why: string) => {
    if (reason !== null) return;
    reason = why;
    if (!isReady) {
      rejectReady(
        new Error(`device service ${name} is not running (${stderr.trim().slice(0, 300) || why})`),
      );
    }
    io.close();
    const w = waiting;
    waiting = null;
    w?.({ value: undefined, done: true });
    resolveClosed({ reason: why });
  };

  const sink: RelaySink = {
    stdout(chunk) {
      if (reason !== null) return;
      let msgs: Uint8Array[];
      try {
        msgs = decoder.push(chunk);
      } catch (e) {
        finish(`the service sent an invalid message: ${(e as Error).message}`);
        return;
      }
      for (const m of msgs) {
        const w = waiting;
        if (w) {
          waiting = null;
          w({ value: m, done: false });
        } else {
          queue.push(m);
          queuedBytes += m.byteLength;
        }
      }
      if (io.pause === undefined) {
        if (queuedBytes >= RELAY_HARD_CAP_BYTES) finish(RELAY_FELL_BEHIND);
      } else if (!paused && queuedBytes > RELAY_HIGH_WATER_BYTES) {
        paused = true;
        io.pause();
      }
    },
    stderr(chunk) {
      if (isReady) return;
      stderr += Buffer.from(chunk).toString("utf8");
      if (stderr.length > 4096) stderr = stderr.slice(-4096);
      if (/(^|\n)ready\n/.test(stderr)) {
        isReady = true;
        resolveReady();
      }
    },
    ended(why) {
      finish(why ?? "the service closed the connection");
    },
  };

  const next = (): Promise<IteratorResult<Uint8Array>> => {
    const m = queue.shift();
    if (m !== undefined) {
      queuedBytes -= m.byteLength;
      if (paused && queuedBytes <= RELAY_HIGH_WATER_BYTES / 2) {
        paused = false;
        io.resume?.();
      }
      return Promise.resolve({ value: m, done: false });
    }
    if (reason !== null) return Promise.resolve({ value: undefined, done: true });
    // one reader: a second waiting next() would leave the first one hanging forever
    if (waiting !== null)
      return Promise.reject(new Error(`device service ${name}: the stream has one reader`));
    return new Promise((r) => {
      waiting = r;
    });
  };

  const stream: DeviceStream = {
    async send(message) {
      if (reason !== null) throw new Error(`device service ${name}: the stream is closed`);
      if (message.byteLength > DEVICE_SERVICE_MAX_MESSAGE) {
        throw new RangeError(
          `service message of ${message.byteLength} bytes exceeds ${DEVICE_SERVICE_MAX_MESSAGE} bytes`,
        );
      }
      try {
        await io.write(encodeServiceMessage(message));
      } catch (e) {
        // a send racing the stream's end (the service answered and closed while the bytes were
        // on their way) is dropped with the stream; otherwise the transport failed
        if (reason !== null) return;
        throw e;
      }
    },
    messages: {
      [Symbol.asyncIterator]: () => ({
        next,
        // a reader that stops (break, throw) is done with the stream: the relay ends with it
        return: async () => {
          finish("the reader stopped reading");
          return { value: undefined, done: true };
        },
      }),
    },
    close(why) {
      finish(why ?? "closed");
    },
    closed,
  };
  return { sink, ready, stream };
}

/**
 * One `request` exchange over an opened relay stream: sends `{"kind":"request"}` and the body,
 * resolves the service's one answer, then closes. Times out after `timeoutMs`, ends on abort.
 */
export async function relayRequest(
  name: string,
  opened: { ready: Promise<void>; stream: DeviceStream },
  body: Uint8Array,
  opts: { timeoutMs: number; signal: AbortSignal },
): Promise<Uint8Array> {
  const { stream } = opened;
  const limit = AbortSignal.any([opts.signal, AbortSignal.timeout(opts.timeoutMs)]);
  const timeout = () =>
    new Error(`device service ${name} did not answer within ${String(opts.timeoutMs)} ms`);
  const onAbort = () => stream.close(opts.signal.aborted ? "aborted" : "timed out");
  limit.addEventListener("abort", onAbort, { once: true });
  if (limit.aborted) onAbort();
  try {
    try {
      await opened.ready;
    } catch (e) {
      opts.signal.throwIfAborted();
      if (limit.aborted) throw timeout();
      throw e;
    }
    await stream.send(new TextEncoder().encode(JSON.stringify({ kind: "request" })));
    await stream.send(body);
    const first = await stream.messages[Symbol.asyncIterator]().next();
    if (first.done) {
      opts.signal.throwIfAborted();
      if (limit.aborted) throw timeout();
      const { reason } = await stream.closed;
      throw new Error(`device service ${name} closed the request without an answer (${reason})`);
    }
    return first.value;
  } catch (e) {
    // a send that failed because the abort closed the stream reports the abort
    opts.signal.throwIfAborted();
    if (limit.aborted && !(e instanceof Error && e.message.includes("did not answer"))) {
      throw timeout();
    }
    throw e;
  } finally {
    limit.removeEventListener("abort", onAbort);
    stream.close("answered");
  }
}
