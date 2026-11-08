# @capybara-hq/plugin-theme-cyberpunk

赛博朋克 / Cyberpunk: the official showcase theme for Capybara. It restyles the web UI with
neon yellow on deep blue-black, a cyan glow, sharp corners, a techno type pair and a neon pixel
capybara. It is our own design and uses no third-party game assets, names or fonts.

This version is an **L0 theme** (core spec `2026-11-08-themes-design.md`): a declarative plugin
with no extension code, so it needs no permission approval. It carries one theme file,
[`themes/cyberpunk.json`](./themes/cyberpunk.json), plus the fonts and the logo it uses.

## The theme `cyberpunk`

- **Dark only** (single-scheme): while it is active the scheme toggle is hidden.
- **Palette** (design tokens it overrides; every other token keeps Capybara's dark value):

  | Token | Value | Role |
  |---|---|---|
  | `bg` | `#070A12` | page ground, deep blue-black |
  | `panel` / `raised` / `sidebar` | `#0C1120` / `#101629` / `#0A0E1B` | surfaces |
  | `hover` / `selected` / `sidebar-active` | `#141C33` / `#1D2945` / `#1B2642` | states |
  | `ink` / `muted` | `#E6F4FF` / `#93A7C6` | text |
  | `accent` / `on-accent` | `#FFE600` / `#0A0B00` | neon yellow and the text on it |
  | `line-card`, `scroll-thumb`, `focus-ring` | cyan `rgba(0,229,255,…)` | cyan secondary touches |
  | `ok` / `warn` / `fail` | `#3DFFA2` / `#FF9F1C` / `#FF5470` | status |
  | shadows | cyan glow, e.g. `0 0 16px rgba(0,229,255,0.12)` | depth |
  | radius | `sm` 0, `md` 2, `bubble` 2 | sharp corners |

  It passes every contrast and separation floor of Capybara's design tokens (checked by
  `capybara-plugin check` and at import), e.g. `ink` on `bg` 17.7:1, `muted` on `selected`
  5.9:1, `on-accent` on `accent` 15.6:1.
- **Fonts**: JetBrains Mono for the UI font (`mono`, 400 / 500 / 600 / 700) and Chakra Petch for
  prose (`prose`, 400 / 600 / 700), Latin subsets; Chinese and other scripts fall back to the
  built-in stacks (Sarasa Mono SC, Source Han Sans SC).
- **Logo**: [`logo.svg`](./logo.svg), Capybara's 14×10 pixel capybara redrawn in neon: a yellow
  body, a cyan eye and a one-pixel cyan offset like a misaligned display. The favicon
  [`favicon.svg`](./favicon.svg) is the same mark on a square dark ground (also the plugin
  icon). The wordmark reads `CYBERBARA`.

## Install

A super admin imports the plugin from the official marketplace (or uploads the tgz); an org admin
may also upload it to their org, where it takes effect at once since it contains no code. Then
pick it in 平台设置 › 外观 (platform default), 组织设置 › 外观 (org default) or
个人设置 › 偏好设置 › 外观 (your own pick).

## What comes next

Later versions of this plugin follow the next layers of Capybara's plugin UI (slots, client
components, decoration): a HUD panel, scanlines and other effects. The layout of this directory
leaves room for them (an extension under `src/`, UI under `ui/`).

## Fonts and licenses

The plugin's own files (theme, logo, docs) are under Apache-2.0 (`LICENSE`). The fonts are under
the SIL Open Font License 1.1, whose full text ships next to them:

| Font | Files | Source | License |
|---|---|---|---|
| JetBrains Mono | `fonts/JetBrainsMono-{400,500,600,700}.woff2` (Latin) | [`@fontsource/jetbrains-mono`](https://www.npmjs.com/package/@fontsource/jetbrains-mono) 5.3.0, © 2020 The JetBrains Mono Project Authors | OFL-1.1, [`OFL-JetBrainsMono.txt`](./OFL-JetBrainsMono.txt) |
| Chakra Petch | `fonts/ChakraPetch-{400,600,700}.woff2` (Latin) | [`@fontsource/chakra-petch`](https://www.npmjs.com/package/@fontsource/chakra-petch) 5.3.0, © 2018 The Chakra Petch Project Authors | OFL-1.1, [`OFL-ChakraPetch.txt`](./OFL-ChakraPetch.txt) |

## 中文简介

赛博朋克主题是 Capybara 官方的展示主题：深蓝黑底、霓虹黄强调色、青色辉光与直角，界面字体用
JetBrains Mono，正文字体用 Chakra Petch（仅拉丁字符，中文回落到内置字体），标志是霓虹配色的像素
水豚，字标为 `CYBERBARA`。本版本是 L0 声明式主题，不含扩展代码，无需权限审批；只有深色一种配色，
并通过全部对比度与分隔度下限。后续版本会随插槽、客户端组件与装饰层加入 HUD 面板、扫描线等效果。
字体均为 SIL OFL 1.1 授权，许可证全文随插件分发。
