// Model-visible texts fixed by the browser use plan (Global Constraints, Task 15), shared by the
// tools and the tests.

/** A browser tool called by a run whose trigger account is not the conversation's owner. */
export const NOT_OWNER_MESSAGE =
  "Browser tools only run for the conversation's owner on their own device.";

/** A browser tool other than wait / handoff while the person controls the browser. */
export const TAKEN_OVER_MESSAGE =
  "The user is controlling the browser; call browser_wait or browser_handoff.";

/**
 * The one next step after a host the device's network refused (the kernel raises the network ask
 * from the reported hosts and reruns the call once the user allows it).
 */
export const BLOCKED_NEXT_STEP =
  "The user is asked to allow the host; if they decline, use another site.";

/** A service start (ensureService) that failed for a reason the kernel gave no text for. */
export const START_FAILED_MESSAGE =
  "The browser could not start in the device; retry, and ask the user to check the device if it keeps failing.";
