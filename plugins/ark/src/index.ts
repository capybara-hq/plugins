import {
  defineExtension,
  MODEL_PROVIDER_EXTENSION_POINT_V2,
  ModelError,
  type ModelProvider,
} from "@capybara-hq/plugin-sdk";

const provider: ModelProvider = {
  async listModels() {
    return [];
  },
  // biome-ignore lint/correctness/useYield: skeleton, replaced by the real implementation
  async *stream() {
    throw new ModelError("invalid_request", "not implemented");
  },
};

/** Volcengine Ark models provider (skeleton). */
export default defineExtension({
  name: "ark",
  version: "0.1.0-rc.0",
  sdk: "^0.1.0-rc.4",
  provides: [MODEL_PROVIDER_EXTENSION_POINT_V2],
  setup(ctx) {
    ctx.provide(MODEL_PROVIDER_EXTENSION_POINT_V2, provider);
  },
});
