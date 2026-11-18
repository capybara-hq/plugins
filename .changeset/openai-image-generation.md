---
"@capybara-hq/plugin-openai": patch
---

Image generation: the `imageModels` deployment setting offers GPT image models (`gpt-image-1.5`, `gpt-image-1-mini`, `gpt-image-2`, `gpt-image-2.5-sunburst`, `gpt-image-2.5-flare`) through `generateImage`, using `/v1/images/generations` and, with reference images, `/v1/images/edits`. Moderation rejections map to `refusal`.
An unknown id in `imageModels` is ignored with a warning instead of failing the config; reference images must be PNG, JPEG or WebP; a response with fewer `b64_json` images than asked is a `server` error.
