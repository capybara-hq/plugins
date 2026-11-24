// Model-visible texts fixed by the browser use plan (Global Constraints, Task 15), shared by the
// tools and the tests.

/** A browser tool called by a run whose trigger account is not the conversation's owner. */
export const NOT_OWNER_MESSAGE =
  "Browser tools only run for the conversation's owner on their own device.";

/** A browser tool other than wait / handoff while the person controls the browser. */
export const TAKEN_OVER_MESSAGE =
  "The user is controlling the browser; call browser_wait or browser_handoff.";

/** The person cancelled (or dismissed) the handoff question. */
export const HANDOFF_CANCELLED_MESSAGE = "The user cancelled the handoff.";

/** A browser tool in a conversation without a device. */
export const NO_DEVICE_MESSAGE =
  "This conversation has no device; pick a device for the conversation first.";
