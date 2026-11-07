# Alibaba Bailian models

Model provider (`model-provider@2`) for Alibaba Cloud Model Studio (Bailian) on DashScope's native
API.

- Models come from the platform list (`GET /api/v1/models`, all pages), grouped by kind: chat,
  embedding, rerank, image / video generation, speech to text, text to speech (only chat and
  embedding are callable). Models served by third-party inference providers are left out (not
  verified on the native endpoint).
- Chat: native text-generation (text models) or multimodal-generation (vision models) with SSE;
  parameters `thinking`, `temperature`, `maxOutputTokens`; explicit prompt cache markers on the
  system prompt.
- Embeddings: `text-embedding-v4`, `text-embedding-v3`, `text-embedding-v2`,
  `qwen3.7-text-embedding`, `qwen3.7-text-embedding-flash` (dimensions and batch sizes bundled).
- Config: `apiKey`, `region` (default `cn-beijing`), `workspaceId` (required outside
  `us-east-1`; optional in `cn-beijing`, which then uses `dashscope.aliyuncs.com`), all overridable
  per organization.
