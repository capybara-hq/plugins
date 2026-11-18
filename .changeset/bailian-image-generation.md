---
"@capybara-hq/plugin-bailian": patch
---

Image generation: the Qwen-Image 2.0 models and wan2.6-t2i (sync multimodal-generation) and
wan2.5 / wan2.2 / wanx2.1 / wanx2.0 text-to-image models (async task, polled inside the call) list
`imageGeneration` and are callable through `generateImage`. Result images are downloaded inside the
call and returned as bytes; content moderation rejections are `refusal`.
Downloads are capped at 50 MB and never follow redirects (both `server`); a throttled (429) task
poll waits longer and keeps polling instead of failing the call.
