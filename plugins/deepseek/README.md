# DeepSeek models

Model provider (`model-provider@2`) for DeepSeek chat models through the Chat Completions API
(`https://api.deepseek.com`), using the official `openai` SDK.

## Config

| Field | Notes |
|---|---|
| `apiKey` | secret; required; overridable per organization |
| `baseUrl` | default `https://api.deepseek.com`; overridable per organization |

The key is required, so a deployment without one shows the provider as needing configuration
rather than as failing to list its models. The platform may leave it empty for the organizations
to fill in (the kernel loads the extension with required overridable fields optional): each
organization following the platform then needs configuration and is never called, and an
organization copy brings its own key.

An organization that sets its own copy is resolved as a whole: its `apiKey` and `baseUrl` are used
together and the platform key is never sent to an organization's `baseUrl`. An organization copy
without a key fails with `auth`.

## Models and parameters

- Models come from `GET {baseUrl}/models`; limits, image input and effort levels are read from the
  response and a small bundled table fills in missing limits.
- Thinking mode: parameters `thinking` (`off` / `on`) and `effort`; `reasoning_content` is replayed
  as the API requires, and automatic prefix caching is reported in usage.
- Chat only; no embeddings.

## Verified live (2026-11-08)

The conformance suite passed against the real API on `deepseek-flash`: text, tools, parameters,
thinking replay, caching, usage, mid-conversation system, image and abort (13/13). The `/models`
response is recorded in `test/fixtures.ts`.

## Known limits

- DeepSeek documents no structured context-overflow code, so a real overflow 400 maps to
  `invalid_request`; only a 413 or the code `context_length_exceeded` maps to `context_overflow`.
- `stream` does not consult `/models`: every model is assumed to reason unless `thinking` is `off`.
- The SDK's `toolChoice` only has `auto` and `none`; a forced tool choice is refused.

## Icon

`icon.svg`: the DeepSeek whale mark (owner: DeepSeek), downloaded on 2026-11-08 from
https://github.com/deepseek-ai/DeepSeek-LLM at 6712a86bfb7d (images/logo.svg); DeepSeek publishes no
brand or press page, so this is its logo from its own repository. It is a trademark of its owner,
used only to identify the service this plugin connects to; the plugin is not affiliated with or
endorsed by the owner. The artwork is unchanged except for removing editor metadata and setting a
square viewBox; only the whale mark is kept, the wordmark is omitted.
