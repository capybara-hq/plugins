# @capybara-hq/plugin-openai

OpenAI model provider (model-provider@2) using the official SDK and the native Responses API.

## Configuration

The deployment config (`apiKey`, optional `baseUrl` and `organization`, `models`,
`reasoningSummary`) has one image setting:

- `imageModels` (optional, none by default): the GPT image model ids to offer through
  `generateImage`. The plugin knows the facts (sizes, images per call, reference images) of
  `gpt-image-1.5`, `gpt-image-1-mini`, `gpt-image-2`, `gpt-image-2.5-sunburst` and
  `gpt-image-2.5-flare`. Any other id (for example the retired `gpt-image-1`) is ignored with one
  warning in the log, so a retired model never breaks the provider's config. Reference images
  (PNG, JPEG or WebP) go to `/v1/images/edits`; prompts alone go to `/v1/images/generations`.

## Icon

`icon.svg`: the OpenAI Blossom mark (owner: OpenAI), downloaded on 2026-11-09 from
https://openai.com/brand/, which served it inline (the brand page's asset downloads sit behind a
browser check that could not be passed). It is a trademark of its owner, used only to identify the
service this plugin connects to; the plugin is not affiliated with or endorsed by the owner. The
artwork is unchanged except for removing markup attributes and setting the fill; it shows in black
on light backgrounds and in white on dark ones.
