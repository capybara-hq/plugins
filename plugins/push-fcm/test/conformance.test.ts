import { describePushProviderConformance } from "@capybara-hq/testing";
import { makeFcmProvider } from "../src/provider.js";
import { memoryKv, startFakeFcm } from "./fake-fcm.js";

/** push-provider@1 conformance against the local fake of Google's token endpoint and FCM v1. */
describePushProviderConformance({
  plugin: "push-fcm",
  async make() {
    const fake = await startFakeFcm();
    const provider = makeFcmProvider({
      config: { serviceAccount: fake.serviceAccount, applicationIds: ["com.example.app"] },
      kv: memoryKv(),
      endpoints: { tokenUrl: fake.tokenUrl, apiBase: fake.apiBase },
    });
    return {
      provider,
      arrange: (token, outcome) => fake.arrange(token, outcome),
      requests: () => fake.requests(),
      close: () => fake.close(),
    };
  },
});
