# Capybara official plugins

The official plugins of [Capybara](https://github.com/capybara-hq/core), an open-source enterprise
agent platform. Each plugin is published to npm as `@capybara-hq/plugin-<name>` (a plugin tgz, with
npm provenance naming this repository) and listed in the official marketplace,
[`.capybara-plugin/marketplace.json`](.capybara-plugin/marketplace.json), with the sha512 of every
published version. A Capybara deployment imports them from the marketplace (on by default) or from
npm; the kernel verifies each download against that integrity.

| Plugin | What it provides |
|---|---|
| [`anthropic`](plugins/anthropic) | Anthropic model provider (`model-provider@2`, native Messages API) |
| [`openai`](plugins/openai) | OpenAI model provider (`model-provider@2`, native Responses API) |
| [`openai-compatible`](plugins/openai-compatible) | Model provider for Chat Completions-compatible services (vLLM, DeepSeek, Qwen, ...) |
| [`connector-mcp`](plugins/connector-mcp) | MCP connector (`connector@1`, Streamable HTTP) |
| [`connector-openapi`](plugins/connector-openapi) | OpenAPI connector (`connector@1`, one tool per operation) |
| [`slack`](plugins/slack) | Slack bot (`channel@1`), Sign in with Slack (`identity-source@1`), directory sync (`directory@1`) |
| [`lark`](plugins/lark) | Lark bot (`channel@1`), Lark login (`identity-source@1`), directory sync (`directory@1`) |
| [`sandbox-docker`](plugins/sandbox-docker) | Conversation sandboxes as Docker containers (`sandbox@1`) |
| [`sandbox-e2b`](plugins/sandbox-e2b) | Conversation sandboxes on E2B (`sandbox@1`) |
| [`object-store-s3`](plugins/object-store-s3) | Object storage on S3-compatible services (`object-store@1`) |
| [`todo`](plugins/todo) | A per-conversation todo list tool for agents |
| [`example-counter`](plugins/example-counter), [`example-board`](plugins/example-board) | Reference implementations for plugin authors (not published) |

`openai-compatible` and `object-store-s3` are bootstrap plugins: core's images bake the versions
pinned in core's `packages/kernel/bootstrap.json` and install them offline.

## Development

Node 24, pnpm 10 and Docker (the tests start PostgreSQL and Valkey with Testcontainers;
`sandbox-docker` builds its images).

```bash
pnpm install
pnpm doctor:env   # check your environment
pnpm verify       # the checks CI requires, for your branch
pnpm exec vitest run plugins/slack
```

The kernel, the plugin SDK, the test kit and the plugin toolchain (`capybara-plugin`) come from npm
(`@capybara-hq/plugin-sdk`, `@capybara-hq/testing`, `@capybara-hq/plugin-tools`,
`@capybara-hq/plugin-model-fake`); a change to them is a pull request in
[capybara-hq/core](https://github.com/capybara-hq/core). [AGENTS.md](AGENTS.md) has the repository
rules, and [`.agents/skills/`](.agents/skills) the guides for writing plugins.

## Contributing

See [CONTRIBUTING.md](CONTRIBUTING.md) and the
[organization guide](https://github.com/capybara-hq/.github/blob/main/CONTRIBUTING.md).

## License

[Apache-2.0](LICENSE)
