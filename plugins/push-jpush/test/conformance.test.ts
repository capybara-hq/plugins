import { describePushProviderConformance } from "@capybara-hq/testing";
import { createJPushProvider } from "../src/jpush.js";
import { startFakeJPush } from "./fake-jpush.js";

/** The push-provider@1 conformance suite against the fake JPush. */
describePushProviderConformance({
  plugin: "push-jpush",
  async make() {
    const fake = await startFakeJPush();
    const provider = createJPushProvider(
      {
        appKey: fake.appKey,
        masterSecret: fake.masterSecret,
        applicationIds: ["com.example.app"],
      },
      { baseUrl: fake.url },
    );
    return {
      provider,
      arrange: (token, outcome) => fake.arrange(token, outcome),
      requests: () => fake.vendorRequests(),
      close: () => fake.stop(),
    };
  },
});
