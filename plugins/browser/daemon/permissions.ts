// The permission report (dialogs spec §6): headless Chromium refuses permission requests without
// a prompt and CDP has no event for one, so an init script wraps the request APIs and, only when
// the page was refused, calls the daemon's binding with the permission's name. What the page gets
// does not change (the same value, settled at the same time: the report only observes), and the
// wrapped functions keep their native `toString`. Any page script can call the binding, so the
// daemon trusts nothing in a report but a known permission name (actions.ts).

/** The most reports one page load sends the daemon (more are dropped there). */
export const PERMISSION_REPORTS_PER_LOAD = 5;

/**
 * The init script's source: `binding` is the per-daemon name of the exposed binding. Pure: the
 * tests run it in a page and in a plain JS context.
 */
export function permissionInitScript(binding: string): string {
  return `(() => {
  const report = globalThis[${JSON.stringify(binding)}];
  if (typeof report !== "function") return;
  const send = (name) => {
    try {
      Promise.resolve(report(name)).catch(() => {});
    } catch {}
  };
  const originals = new WeakMap();
  const nativeToString = Function.prototype.toString;
  const toString = {
    toString() {
      const original = originals.get(this);
      return nativeToString.call(original === undefined ? this : original);
    },
  }.toString;
  originals.set(toString, nativeToString);
  try {
    Object.defineProperty(Function.prototype, "toString", {
      value: toString,
      writable: true,
      configurable: true,
    });
  } catch {}
  const wrap = (owner, key, make) => {
    if (owner === null || owner === undefined) return;
    const desc = Object.getOwnPropertyDescriptor(owner, key);
    const original = desc === undefined ? undefined : desc.value;
    if (typeof original !== "function") return;
    const wrapped = make(original);
    originals.set(wrapped, original);
    try {
      Object.defineProperty(wrapped, "name", { value: original.name });
      Object.defineProperty(wrapped, "length", { value: original.length });
      Object.defineProperty(owner, key, { ...desc, value: wrapped });
    } catch {}
  };
  // observes a promise without changing it (the page still gets the very same promise)
  const watch = (p, onValue, onError) => {
    if (p !== null && typeof p === "object" && typeof p.then === "function")
      p.then(onValue, onError);
    return p;
  };
  if (typeof Notification === "function") {
    wrap(Notification, "requestPermission", (original) => ({
      requestPermission(...args) {
        return watch(
          original.apply(this, args),
          (r) => {
            if (r !== "granted") send("notifications");
          },
          () => {},
        );
      },
    }).requestPermission);
  }
  const denied = (name) => (e) => {
    if (e !== null && typeof e === "object" && e.name === "NotAllowedError") send(name);
  };
  if (typeof Clipboard === "function") {
    for (const key of ["read", "readText"]) {
      wrap(Clipboard.prototype, key, (original) => ({
        [key](...args) {
          return watch(original.apply(this, args), () => {}, denied("clipboard-read"));
        },
      })[key]);
    }
  }
  if (typeof Geolocation === "function") {
    for (const key of ["getCurrentPosition", "watchPosition"]) {
      wrap(Geolocation.prototype, key, (original) => ({
        [key](success, error, ...rest) {
          const onError = function (e) {
            if (e !== null && typeof e === "object" && e.code === 1) send("geolocation");
            if (typeof error === "function") return error.apply(this, arguments);
          };
          return original.call(this, success, onError, ...rest);
        },
      })[key]);
    }
  }
  if (typeof MediaDevices === "function") {
    wrap(MediaDevices.prototype, "getUserMedia", (original) => ({
      getUserMedia(constraints, ...rest) {
        const c = constraints !== null && typeof constraints === "object" ? constraints : {};
        return watch(original.call(this, constraints, ...rest), () => {}, (e) => {
          if (c.video) denied("camera")(e);
          if (c.audio) denied("microphone")(e);
        });
      },
    }).getUserMedia);
  }
})();`;
}
