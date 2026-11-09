# @capybara-hq/plugin-theme-cyberpunk

赛博朋克 / Cyberpunk: the official showcase theme for Capybara. It turns the web UI into a
"cyberpunk capybara": neon yellow on deep blue-black, a cyan glow, chamfered corners, a techno type
pair, a neon pixel capybara, a run-state HUD, scanlines, a boot screen and a glitch `CYBERBARA`
wordmark. It is our own design and uses no third-party game assets, names or fonts.

It uses every layer of Capybara's plugin UI (core specs `2026-11-08-themes-design.md`,
`2026-11-09-client-extensions-design.md`):

- **L0 theme**: [`themes/cyberpunk.json`](./themes/cyberpunk.json) with its fonts and logo (below).
- **L1-L2 components** (`src/client.tsx`, a browser bundle built by `capybara-plugin pack`): five
  `component` contributions of the extension (`src/index.ts`).
- **L3 decoration**: [`client/styles/cyberpunk.css`](./client/styles/cyberpunk.css), selecting
  only the public UI parts (`[data-cap-part]`) and state tokens (`[data-cap-state]`).

Everything but the theme itself scopes itself to the theme: the CSS hangs off the shell token
`theme=theme-cyberpunk/cyberpunk` and the components check `useTheme()`, so a person who picks
another theme sees the built-in brand and hero and no decoration (the HUD section stays, in the
plain design).

## What it adds

| Contribution | Slot | What it does |
|---|---|---|
| `run-hud` | `conversation.properties.section` (after the context section) | The run state (STANDBY / RUNNING / AWAITING INPUT / FAULT) with a signal meter, the viewer's role and the last uplink time from its server view, the runs, tool results and approvals seen since the page opened, and the sound toggle |
| `scanlines` | `shell.overlay` | CRT scanlines and a light vignette over the workspace; a sweep line while a run is going |
| `boot` | `shell.overlay` | A short terminal boot screen, once per browser session |
| `brand` | `shell.brand` (replaceable) | The neon mark and a glitch `CYBERBARA` wordmark in the full sidebar and the drawer; the built-in mark with a flicker in the rail |
| `hero` | `conversation.empty` (replaceable) | The new-conversation hero: the big neon capybara, a status line and the greeting with a glitch |

The decoration CSS chamfers cards, sections, dialogs, the composer and buttons (larger cuts and
uppercase on primary buttons, no clipping while a button has keyboard focus), and colours the HUD,
the properties panel edge, the title bar line and the composer by the run state
(`run=running` neon yellow, `run=waiting` cyan, `run=failed` red, idle green).

`.capybara-plugin/plugin.json` suggests the appearance (`suggestedAppearance`): the theme
`cyberpunk` and the replacements `shell.brand` → `brand`, `conversation.empty` → `hero`. Nothing is
applied on install; an admin applies it in one step (below).

### Sound

Short cues synthesized with the Web Audio API (no audio files): run started, run finished (an error
buzz when aborted), approval requested, tool finished (a tick, or the error buzz for a failed
tool). Sound is **off by default**; the HUD's **Sound: off / on** button turns it on for this
browser (stored with `useClientStorage`, key `cap-ext:theme-cyberpunk:sound`) and plays a short
confirmation.

### Reduced motion and accessibility

- When the system asks for reduced motion (`prefers-reduced-motion`, the `motion=reduced` token),
  the boot screen is skipped, every animation stops (scanline flicker, glitch, meters, cursor) and
  no sound plays even with the toggle on.
- The overlays are decorative: their content is `aria-hidden` and takes no pointer events. The boot
  screen never blocks input (clicks and keys reach the page underneath), ends by itself after about
  two seconds, and **Skip** (or Escape) ends it at once; Skip is the only interactive element.
- The glitch copies of the wordmark and the greeting are hidden from assistive tech; the brand
  reads as `CYBERBARA`. All HUD colours are bright on the theme's dark panels.

## Install and the acceptance

1. A super admin imports the plugin from the official marketplace (or uploads the tgz from
   `pnpm pack-plugins`) and approves its permissions: `permissions.client` and
   `ui.component:run-hud|scanlines|boot|brand|hero` are sensitive and block loading until approved.
2. On the admin plugin detail, click **应用此插件的外观 / Apply this plugin's appearance**: it
   sets the platform default theme to Cyberpunk and the platform's `shell.brand` and
   `conversation.empty` picks to `brand` and `hero`, then reloads the page. (An org admin can do
   the same for one org on the workspace 扩展 page.)
3. Open the workspace: the boot screen plays once, the sidebar shows the glitch wordmark, the new
   conversation shows the cyberpunk hero, scanlines sit over the page. Start a conversation: the
   HUD in the properties panel turns yellow while the run goes, cyan when it waits for input, red
   on a failure. Turn sound on in the HUD to hear the cues.
4. `?safe-ui=1` (or 平台设置 › 插件界面代码 off, or disabling the plugin) returns the official UI;
   picking another theme in 个人设置 › 偏好设置 › 外观 removes the decoration.

The theme alone can still be picked without the client code in 平台设置 › 外观, 组织设置 › 外观
or 个人设置 › 偏好设置 › 外观.

## Tests

`test/` covers the theme (tokens, readability, fonts, logo), the pack (`capybara-plugin check` with
no warning, the packed files and manifest), the extension manifest and the HUD view data, and the
client code with the fake host of `@capybara-hq/plugin-client/testing`: the HUD (run states, view
data, counts, the stored sound toggle), the sound listeners (silent by default and under reduced
motion), the boot screen (once per session, reduced motion, Skip / Escape / end of animation) and
the theme fallbacks of the brand and hero. The tests import the fake host as `#client-testing`
(`package.json` `imports`) because `plugin-test-imports` of `@capybara-hq/plugin-tools`
0.1.0-rc.12 does not list `@capybara-hq/plugin-client` yet; switch to the package name once it
does. The client tests run in jsdom and are type-checked by `test/tsconfig.json` (DOM and JSX).

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

## Fonts and licenses

The plugin's own files (theme, logo, code, styles, docs) are under Apache-2.0 (`LICENSE`). The fonts are under
the SIL Open Font License 1.1, whose full text ships next to them:

| Font | Files | Source | License |
|---|---|---|---|
| JetBrains Mono | `fonts/JetBrainsMono-{400,500,600,700}.woff2` (Latin) | [`@fontsource/jetbrains-mono`](https://www.npmjs.com/package/@fontsource/jetbrains-mono) 5.3.0, © 2020 The JetBrains Mono Project Authors | OFL-1.1, [`OFL-JetBrainsMono.txt`](./OFL-JetBrainsMono.txt) |
| Chakra Petch | `fonts/ChakraPetch-{400,600,700}.woff2` (Latin) | [`@fontsource/chakra-petch`](https://www.npmjs.com/package/@fontsource/chakra-petch) 5.3.0, © 2018 The Chakra Petch Project Authors | OFL-1.1, [`OFL-ChakraPetch.txt`](./OFL-ChakraPetch.txt) |

## 中文简介

赛博朋克是 Capybara 官方的展示插件，把界面变成“赛博朋克水豚”：深蓝黑底、霓虹黄强调色、青色辉光、
切角边框，界面字体 JetBrains Mono、正文字体 Chakra Petch（仅拉丁字符，中文回落到内置字体），霓虹像素
水豚标志，字标为 `CYBERBARA`。

- **主题（L0）**：只有深色一种配色，通过全部对比度与分隔度下限。
- **组件（L1-L2）**：对话属性面板里的运行 HUD（运行状态、信号条、操作员角色、上行时间、本页看到的
  运行 / 工具 / 审批次数、音效开关）；覆盖层的扫描线与启动画面（每个浏览器会话一次）；侧栏品牌位的
  故障风字标；新对话页的赛博朋克欢迎区。
- **装饰（L3）**：卡片、分区、对话框、输入框与按钮切角；HUD、属性面板边线、标题栏与输入框随运行状态
  变色（运行中黄、等待输入青、失败红、空闲绿）。

全部装饰只在选用本主题时生效；换成别的主题后，品牌位与欢迎区回到内置样式。音效用 Web Audio 合成，
**默认关闭**，在 HUD 里点“音效：关 / 开”开启（只对本浏览器生效）。系统开启“减少动态效果”时不播放
启动画面、停止所有动画，也不播放音效。覆盖层只做装饰，不接收鼠标事件，启动画面约两秒后自动结束，
可点“跳过”或按 Esc 立即结束。

验收：超级管理员导入插件并批准权限（`permissions.client` 与各 `ui.component:*` 为敏感权限），在插件
详情页点“应用此插件的外观”，即把平台默认主题设为赛博朋克，并把 `shell.brand`、`conversation.empty`
换成本插件的组件，页面随后重新加载。`?safe-ui=1`、关闭“插件界面代码”或停用插件都会回到官方界面。
字体均为 SIL OFL 1.1 授权，许可证全文随插件分发。
