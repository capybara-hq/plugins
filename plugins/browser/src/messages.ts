// Model-visible texts fixed by the browser use plan (Global Constraints, Task 15), shared by the
// tools and the tests. TAKEN_OVER_MESSAGE lives in browser.ts, next to the tab count line the
// tool-design check reads with it.

/** A browser tool called by a run whose trigger account is not the conversation's owner. */
export const NOT_OWNER_MESSAGE =
  "Browser tools only run for the conversation's owner on their own device.";
