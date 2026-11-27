// The install key the daemon's service files carry (capybara-hq/plugins#311): the Chromium
// revisions this build's playwright-core installs (its browsers.json), written by daemon/build.ts
// as the service file `capybara-install-key` (core's DEVICE_SERVICE_INSTALL_KEY_FILE). A
// capybara-device that keeps installs in its machine-wide cache keys the browser install by it,
// so a plugin upgrade that keeps the revisions downloads nothing; an older one ignores the file.

/** The service file naming the install key (the SDK's DEVICE_SERVICE_INSTALL_KEY_FILE). */
export const INSTALL_KEY_FILE = "capybara-install-key";

/** What an install key may hold (the SDK's DEVICE_SERVICE_INSTALL_KEY_RE). */
export const INSTALL_KEY_RE = /^[a-z0-9][a-z0-9._+-]{0,127}$/;

/**
 * The key for a browsers.json: both builds the daemon may install (which one depends on the
 * device's sandbox, known only when it runs), each with its revision, e.g.
 * `chromium-1255+chromium-headless-shell-1255`. Throws when either is missing, or when either has
 * `revisionOverrides` (a revision per host OS, which the key and the provider's platform scope
 * would not name: the key must never lie about what is installed).
 */
export function browserInstallKey(browsersJson: string): string {
  const json = JSON.parse(browsersJson) as {
    browsers?: { name?: unknown; revision?: unknown; revisionOverrides?: unknown }[];
  };
  const parts = ["chromium", "chromium-headless-shell"].map((name) => {
    const entry = json.browsers?.find((b) => b.name === name);
    if (entry?.revisionOverrides !== undefined)
      throw new Error(
        `browsers.json gives ${name} revisionOverrides; extend browserInstallKey to name the revision per host OS`,
      );
    const revision = entry?.revision;
    if (typeof revision !== "string" || !/^\d+$/.test(revision))
      throw new Error(`browsers.json names no revision of ${name}`);
    return `${name}-${revision}`;
  });
  const key = parts.join("+");
  if (!INSTALL_KEY_RE.test(key)) throw new Error(`invalid install key ${key}`);
  return key;
}
