// Device services (browser use spec §5–6), shared by device-docker and device-e2b: this file is
// identical in both plugins (device-e2b's test/services.test.ts compares them byte for byte).
import {
  DEVICE_SERVICE_MAX_MESSAGE,
  DEVICE_SERVICE_NAME_RE,
  type DeviceServiceSpec,
  type DeviceServiceStatus,
  type DeviceStream,
  encodeServiceMessage,
  ServiceMessageDecoder,
} from "@capybara-hq/plugin-sdk";

/**
 * Where a device's service state directories live: persistent with the device's files but outside
 * the workspace, so no project root, Glob / Grep, share or delivery ever reaches a service's state
 * (a browser profile's cookies). Docker: the device's own `<name>-svc` volume mounted here; E2B:
 * a directory on the VM's disk. Owned by the sandbox user (the image makes it; device-e2b creates
 * it as root on a VM whose template predates it).
 */
export const SERVICE_STATE_ROOT = "/var/lib/capybara/svc";

/** The answer when the state root is missing or not the sandbox user's (an image before services). */
export const SERVICE_IMAGE_TOO_OLD =
  "this device's image predates device services; reset the device's instance";

/**
 * Where a service's runtime files live (pid record, socket, lock, log): /tmp, so nothing of a
 * process outlives the instance that ran it (Docker: a tmpfs; E2B: the record is checked against
 * the boot id and the process start time as well).
 */
export const SERVICE_RUN_ROOT = "/tmp/.capybara-svc";

/** The state directory of a service: absolute, stable per device and name, known before start. */
export function serviceStateDir(name: string): string {
  checkServiceName(name);
  return `${SERVICE_STATE_ROOT}/${name}`;
}

/** The unix socket a service listens on (`CAPYBARA_SERVICE_SOCKET`). */
export function serviceSocketPath(name: string): string {
  checkServiceName(name);
  return `${SERVICE_RUN_ROOT}/${name}/sock`;
}

export function checkServiceName(name: string): void {
  if (!DEVICE_SERVICE_NAME_RE.test(name)) {
    throw new Error(`invalid device service name: ${JSON.stringify(name)}`);
  }
}

/** The interpreter of the service manager (system path, never the image's writable PATH). */
export const MANAGER_PYTHON = "/usr/bin/python3";

/** The node binary every service and the relay run on (the published image's Node 22). */
export const SERVICE_NODE = "/usr/local/bin/node";

/**
 * The service manager, run as the sandbox user by the provider: `python3 -I -c <script> <op>
 * <name>` with `op` one of `status`, `ensure` (request on stdin: a 4-byte big-endian length, then
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
 * - A pid record counts only while its process is alive with the recorded start time on the
 *   recorded boot: after a suspend, a restart or a pid reuse it reads as stopped.
 * - The service gets the manager's environment (the instance's, with its egress proxy variables)
 *   with `PATH` set to root-owned directories, the spec's `env`, and the socket and state
 *   variables. Nothing restarts a service that exited: the next `ensure` (reviewed again by the
 *   kernel) does.
 * - A state root that is missing or not the sandbox user's (an image before device services)
 *   answers {@link SERVICE_IMAGE_TOO_OLD}.
 * - `stop` sends SIGTERM to the service's process group, waits up to 5 s, then SIGKILLs every
 *   process left in its session.
 */
export const SERVICE_MANAGER_SCRIPT = `import base64, fcntl, json, os, re, signal, stat, sys, time
NAME_RE = re.compile(r"^[a-z][a-z0-9-]{0,31}$")
KEY_RE = re.compile(r"^[A-Za-z_][A-Za-z0-9_]*$")
STATE = ("/var/lib/capybara/svc", ())
TOO_OLD = "this device's image predates device services; reset the device's instance"
RUN = ("/tmp", (".capybara-svc",))
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

def opendirs(root, parts, create):
    fd = os.open(root, DIR)
    for p in parts:
        try:
            nfd = os.open(p, DIR, dir_fd=fd)
        except FileNotFoundError:
            if not create:
                os.close(fd)
                return None
            try:
                os.mkdir(p, 0o700, dir_fd=fd)
            except FileExistsError:
                pass
            nfd = os.open(p, DIR, dir_fd=fd)
        os.close(fd)
        fd = nfd
    return fd

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

def rundir(name, create):
    base = opendirs(RUN[0], RUN[1], create)
    if base is None:
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
    sock = ("%s/%s/%s/sock" % (RUN[0], RUN[1][0], name)).encode()
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
    data = b""
    while len(data) < n:
        chunk = sys.stdin.buffer.read(n - len(data))
        if not chunk:
            fail("truncated request")
        data += chunk
    return json.loads(data)

def segments(rel):
    parts = rel.split("/")
    if rel.startswith("/") or "\\\\" in rel or "\\0" in rel or any(p in ("", ".", "..") for p in parts):
        fail("invalid service file path %s" % json.dumps(rel))
    return parts

def write_files(sfd, files):
    for rel, b64 in sorted(files.items()):
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
            f.write(base64.b64decode(b64))

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

def ensure(name, req):
    rfd = rundir(name, True)
    st = os.fstat(rfd)
    if st.st_uid != os.getuid() or stat.S_IMODE(st.st_mode) & 0o077:
        fail("the service run directory is not private to the sandbox user")
    lock(rfd)
    rec = read_record(rfd)
    if rec is not None or req.get("ifRunning") is True:
        answer(status(name, rec))
    entry, args, env, files = req.get("entry"), req.get("args"), req.get("env") or {}, req.get("files")
    if not isinstance(files, dict) or not isinstance(entry, str) or entry not in files:
        fail("the service entry must be one of its files")
    if not isinstance(args, list) or not all(isinstance(a, str) and "\\0" not in a for a in args):
        fail("invalid service arguments")
    if not isinstance(env, dict) or not all(isinstance(k, str) and KEY_RE.match(k) and isinstance(v, str) and "\\0" not in v for k, v in env.items()):
        fail("invalid service environment")
    try:
        root = os.open(STATE[0], DIR)
    except OSError:
        fail(TOO_OLD)
    rst = os.fstat(root)
    if rst.st_uid != os.getuid() or not os.access(STATE[0], os.W_OK):
        fail(TOO_OLD)
    try:
        sfd = opendirs_at(root, name, True)
    except OSError as e:
        fail("cannot open the service state directory: %s (a link or a non-directory is in the way)" % e.strerror)
    os.close(root)
    write_files(sfd, files)
    state_dir = status(name, None)["stateDir"]
    sock = "%s/%s/%s/sock" % (RUN[0], RUN[1][0], name)
    unlink(rfd, "sock")
    unlink(rfd, "pid")
    unlink(rfd, "log")
    logfd = open_reg("log", os.O_WRONLY | os.O_CREAT | os.O_TRUNC, rfd)
    # the service's output must not be non-blocking
    os.set_blocking(logfd, True)
    penv = {k: v for k, v in os.environ.items() if not k.startswith("CAPYBARA_")}
    penv.update(env)
    penv.update({"PATH": PATH, "CAPYBARA_SERVICE_SOCKET": sock, "CAPYBARA_SERVICE_STATE": state_dir})
    argv = [NODE, "%s/%s" % (state_dir, entry)] + args
    at = time.time()
    pid = os.fork()
    if pid == 0:
        try:
            os.setsid()
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
 * The `ensure` request on the manager's stdin. With `ifRunning` it carries nothing of the spec:
 * the manager never starts anything then.
 */
export function managerRequest(spec: DeviceServiceSpec, ifRunning: boolean): Uint8Array {
  checkServiceName(spec.name);
  const body = ifRunning
    ? { ifRunning: true }
    : {
        entry: spec.entry,
        args: spec.args,
        env: spec.env ?? {},
        files: Object.fromEntries(
          Object.entries(spec.files).map(([k, v]) => [k, Buffer.from(v).toString("base64")]),
        ),
      };
  const json = Buffer.from(JSON.stringify(body), "utf8");
  const out = Buffer.alloc(4 + json.byteLength);
  out.writeUInt32BE(json.byteLength, 0);
  json.copy(out, 4);
  return out;
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
        return: async () => ({ value: undefined, done: true }),
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
