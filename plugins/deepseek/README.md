# DeepSeek models

Model provider (`model-provider@2`) for DeepSeek chat models through the Chat Completions API
(`https://api.deepseek.com`).

- Models come from `GET {baseUrl}/models` (limits, image input and the effort levels are read from
  the response; a small bundled table fills in missing limits).
- Thinking mode: parameters `thinking` (`off` / `on`) and `effort`; `reasoning_content` is replayed
  as the API requires.
- Config: `apiKey` and `baseUrl`, both overridable per organization.
