# Jina

Provides `web-search@1` and `web-fetch@1` through Jina's search (`s.jina.ai`) and reader (`r.jina.ai`) APIs, so the kernel's builtin `WebSearch` and `WebFetch` tools can use Jina.

- **Search** returns titles, URLs, snippets and publish dates. One allowed domain is passed to Jina as a site filter.
- **Reader** returns a page as markdown; the final URL after redirects is reported back.

## Configuration

- **Organization:** an API key (`apiKey`, secret) from the Jina API dashboard at jina.ai. Each organization sets its own; the provider is not configured until it does.
- **Deployment (advanced):** `searchUrl` and `readerUrl` override the service endpoints, for tests or to go through a proxy. The defaults are the public Jina endpoints.

## Using it

`WebSearch` and `WebFetch` default to the policy "ask", so a person approves the first calls. An organization with more than one web search (or web fetch) provider installed chooses its default in the organization settings; with several providers and no default, the tool is unavailable.

## Live tests

The tests in `test/live` call the real service and run only when `CAPYBARA_TEST_JINA_API_KEY` is set:

```bash
set -a; . ~/.capybara-test.env; set +a; pnpm exec vitest run plugins/jina/test/live
```

## Icon

`icon.svg`: the Jina logo (owner: Jina AI), downloaded on 2026-11-08 from https://jina.ai/about-us/ ("Download
Jina logo", https://jina.ai/logo-Jina-1024.zip, Jina-color.svg and Jina-white.svg; Jina publishes no
square mark). It is a trademark of its owner, used only to identify the service this plugin connects
to; the plugin is not affiliated with or endorsed by the owner. The artwork is unchanged except for
removing editor metadata and setting a square viewBox; it shows the color version on both light
and dark backgrounds.
