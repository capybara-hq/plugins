import { fcmExtension } from "../../src/index.js";

/**
 * The push-fcm extension pointed at a local fake (the test seam: endpoints are a factory argument,
 * never a field of the admin's config schema). The kernel-level test sets
 * `CAPYBARA_PUSH_FCM_FAKE_BASE` before the kernel imports this file.
 */
const base = process.env.CAPYBARA_PUSH_FCM_FAKE_BASE;
if (base === undefined) throw new Error("CAPYBARA_PUSH_FCM_FAKE_BASE is not set");

export default fcmExtension({ tokenUrl: `${base}/token`, apiBase: base });
