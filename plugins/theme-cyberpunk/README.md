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

Everything but the theme itself scopes itself to the theme: every CSS rule hangs off
`:root:has([data-cap-state~="theme=theme-cyberpunk/cyberpunk"])` (the run states off the same with
`run=…`), so it also reaches what the host portals out of the shell: dialogs, menus, the command
palette, the properties sheet below 1100 px and the sidebar drawer. The components check
`useTheme()`. A person who picks another theme sees the built-in brand and hero and no decoration
(the HUD section stays, in the plain design).

## What it adds

| Contribution | Slot | What it does |
|---|---|---|
| `run-hud` | `conversation.properties.section` (after the context section) | The run state in the viewer's language (zh 待命 / 运行中 / 等待输入 / 故障, en STANDBY / RUNNING / AWAITING INPUT / FAULT) with a `T+MM:SS.s` ticker of the run's time and an equalizer-style signal meter; the viewer's role (localized) and the last uplink time from its server view; the runs, tool calls and approvals of the conversation seen live in this browser tab (counted by the extension's listeners from the page's first load, kept in session client storage; "—" until it has seen one, since earlier history is not counted); and the sound toggle |
| `scanlines` | `shell.overlay` | Static CRT scanlines and a very light vignette over the workspace |
| `boot` | `shell.overlay` | A short opaque terminal boot screen (boot lines with a right-aligned status column, then a progress bar), once per sign-in, about two seconds, ending like a CRT switching off |
| `brand` | `shell.brand` (replaceable) | The neon mark (the theme logo through the design `Logo`) and a glitch `CYBERBARA` wordmark in the full sidebar and the drawer, in place of the built-in row; the built-in mark with a flicker in the rail |
| `hero` | `conversation.empty` (replaceable) | The new-conversation hero: the big neon capybara, a status line and the greeting with a glitch |

The decoration CSS bevels cards, stat cards, sections, dialogs, menus, code blocks, the user's
message bubbles, the composer, buttons, inputs, segmented controls, agent chips, switches and the
org initial with `corner-shape: bevel`: the border, the background and the focus ring all follow
the diagonal, so outlines are continuous and focus rings stay whole (a browser without
`corner-shape` keeps square corners). Input borders read at 3:1 or more on the page, panel and
raised grounds; focus is one colour, the neon yellow, everywhere; selected text is neon. Switches
get a square knob that reads when off, the org initial becomes a neon tag, and the selected agent
chip a neon edge. Primary buttons keep their text as written.

### Run effects

Everything follows the run state (`run=running` neon yellow, `run=waiting` cyan, `run=failed` red,
idle green), moves only `transform` and `opacity`, shifts no layout and stops under reduced motion:

- **Running**: a light sweeps along the title bar's fading bottom edge; the HUD bars move like an
  equalizer next to the run's `T+` ticker; a scan beam passes over the reply being written; a light
  travels along the composer's border. Nothing moves across the whole screen: the scanlines stay still.
- **Waiting for input**: everything holds in cyan and breathes slowly (the HUD, the composer's
  outline).
- **Failed**: one short red glitch on the title bar edge and the HUD state, then a steady red line
  and a flat meter.

The beam is a pseudo-element of the reply being written (the `message.assistant` part while it
carries `aria-busy`), the composer light one of the
`composer` part: nothing runs or is measured outside a run, and a sheet, dialog, menu or the
drawer opened over them covers them. Only the static scanlines live in the decoration layer
above everything; they take no part in a run.

`.capybara-plugin/plugin.json` suggests the appearance (`suggestedAppearance`): the theme
`cyberpunk` and the replacements `shell.brand` → `brand`, `conversation.empty` → `hero`. Nothing is
applied on install; an admin applies it in one step (below).

### Sound

Short cues synthesized with the Web Audio API (no audio files): run started, run finished (an error
buzz when aborted), run failed (the error buzz), approval requested, tool finished (a tick, or the
error buzz for a failed tool). Sound is **off by default**; the HUD's **Sound: off / on** button
turns it on for this browser (stored with `useClientStorage`, key `cap-ext:theme-cyberpunk:sound`)
and plays a short confirmation. One cue plays at a time (a burst of events, such as the catch-up of
a revisited conversation, plays once), nothing plays before the page's first click or key press,
and every audio context is closed when its cue ends or when the browser does not let it start.
The cues and the HUD follow the toggle, not the theme: listeners get no theme
(`ClientApi` has none yet), and the HUD carries the only off switch.

### Reduced motion and accessibility

- When the system asks for reduced motion (`prefers-reduced-motion`, the `motion=reduced` token),
  the boot screen and the run effects are skipped, every animation stops (scanline flicker, glitch,
  meters, edges) while the colours and lines stay, and no sound plays even with the toggle on.
- The overlays are decorative: their content is `aria-hidden` and takes no pointer events. The boot
  screen never blocks input (clicks and keys reach the page underneath), ends by itself after about
  two seconds, and **Skip** (or Escape) ends it at once; Skip is the only interactive element.
- The boot screen plays once per sign-in: it keys on the sign-in id of `useSignIn()` (kept in local
  client storage), so a reload or a new tab of the same sign-in does not replay it and the next
  sign-in does. It needs a Capybara whose web host offers `useSignIn` and the UI parts it styles
  (core 0.1.0-rc.19 and later: kernel rc.19, plugin-client 0.1.0-rc.4, the peer range); an
  older host loads no client code of this plugin (the built-in brand, hero and no HUD), while its
  theme and stylesheet still apply.
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
3. Open the workspace: the boot screen plays once after sign-in, the sidebar shows the glitch
   wordmark, the new conversation shows the cyberpunk hero, scanlines sit over the page. Start a
   conversation: the HUD in the properties panel reads 运行中 (RUNNING) in yellow while the run
   goes, 等待输入 (AWAITING INPUT) in cyan when it waits for input, 故障 (FAULT) in red on a
   failure and 待命 (STANDBY) in green when idle. Turn sound on in the HUD to hear the cues. Tab
   through `/agents`: the focused card's ring is whole.
4. `?safe-ui=1` (or 平台设置 › 插件界面代码 off, or disabling the plugin's client code) removes
   every component, the overlays and the plugin CSS: the built-in brand, hero and composer return.
   The L0 theme (palette, fonts, the neon logo and its `CYBERBARA` wordmark) **stays**, because a
   theme is declarative, not client code; to return to the official look, pick another theme in
   平台设置 › 外观 (or 个人设置 › 偏好设置 › 外观), which also removes the decoration.

The theme alone can still be picked without the client code in 平台设置 › 外观, 组织设置 › 外观
or 个人设置 › 偏好设置 › 外观.

## Tests

`test/` covers the theme (tokens, readability, fonts, logo), the pack (`capybara-plugin check` with
no warning, the packed files and manifest), the extension manifest and the HUD view data, and the
client code with the fake host of `@capybara-hq/plugin-client/testing`: the HUD (run states, view
data, the localized role, "—" before any count, session counts recorded by the listeners and the HUD
once each, the run ticker, the stored sound toggle), the sound listeners (silent by default, under
reduced motion and before a user gesture; one cue for a burst; suspended contexts closed), the boot
screen (once per sign-in id: not again in a reload or a new tab of the same sign-in, again after a
new one; the status column, reduced motion, Skip / Escape / end of animation, the deadline, no
listener left), the stylesheet (every rule scoped through `:root:has`, bevels on every chamfered
part, no uppercase, soft edges, run animations on transform and opacity only, every animated
selector stopped or hidden by both reduced-motion blocks, which outweigh the run-state rules) and
the theme fallbacks of the brand and hero (and its layout per sidebar panel). The client tests run
in jsdom and are type-checked by `test/tsconfig.json` (DOM and JSX).

## The theme `cyberpunk`

- **Dark only** (single-scheme): while it is active the scheme toggle is hidden.
- **Palette** (design tokens it overrides; every other token keeps Capybara's dark value):

  | Token | Value | Role |
  |---|---|---|
  | `bg` | `#070A12` | page ground, deep blue-black |
  | `panel` / `raised` / `sidebar` | `#0C1120` / `#101629` / `#0A0E1B` | surfaces |
  | `hover` / `selected` / `sidebar-active` | `#141C33` / `#1D2945` / `#1B2642` | states |
  | `ink` / `muted` / `faint` | `#E6F4FF` / `#93A7C6` / `#7084A8` | text (`faint` 5.2:1 on `bg`, 3.8:1 on `selected`) |
  | `line` / `line-strong` | `#34486E` / `#4E6796` | dividers and borders (`line-strong` for input borders: 3.5:1 on `bg`, 3.3:1 on `panel`, 3.2:1 on `raised`) |
  | `accent` / `on-accent` | `#FFE600` / `#0A0B00` | neon yellow and the text on it |
  | `line-card`, `scroll-thumb` | cyan `rgba(0,229,255,…)` | cyan secondary touches |
  | `focus-ring` | `rgba(255,230,0,0.35)` | the halo around focused inputs and selects, in the neon yellow of the focus outline (`accent`) |
  | `ok` / `warn` / `fail` | `#3DFFA2` / `#FF9F1C` / `#FF5470` | status |
  | shadows | cyan glow, e.g. `0 0 16px rgba(0,229,255,0.12)` | depth |
  | radius | `sm` 0, `md` 2, `bubble` 2 | square base corners, chamfered by the plugin CSS |

  It passes every contrast and separation floor of Capybara's design tokens (checked by
  `capybara-plugin check` and at import), e.g. `ink` on `bg` 17.7:1, `muted` on `selected`
  5.9:1, `on-accent` on `accent` 15.6:1.
- **Fonts**: JetBrains Mono for the UI font (`mono`, 400 / 500 / 600 / 700) and Chakra Petch for
  prose (`prose`, 400 / 600 / 700), Latin subsets; Chinese and other scripts fall back to the
  built-in stacks (Sarasa Mono SC, Source Han Sans SC).
- **Logo**: [`logo.svg`](./logo.svg), Capybara's 14×10 pixel capybara redrawn in neon: a yellow
  body, a cyan eye and a one-pixel cyan offset like a misaligned display. The favicon
  [`favicon.svg`](./favicon.svg) is the same mark, cyan offset included, on a transparent 16×16
  ground (also the plugin icon, so it sits in any icon tile; the cyan copy outlines it on light
  tab bars). The wordmark reads `CYBERBARA`.

## Fonts and licenses

The plugin's own files (theme, logo, code, styles, docs) are under Apache-2.0 (`LICENSE`). The
fonts are under the SIL Open Font License 1.1, whose full text ships next to them:

| Font | Files | Source | License |
|---|---|---|---|
| JetBrains Mono | `fonts/JetBrainsMono-{400,500,600,700}.woff2` (Latin) | [`@fontsource/jetbrains-mono`](https://www.npmjs.com/package/@fontsource/jetbrains-mono) 5.3.0, © 2020 The JetBrains Mono Project Authors | OFL-1.1, [`OFL-JetBrainsMono.txt`](./OFL-JetBrainsMono.txt) |
| Chakra Petch | `fonts/ChakraPetch-{400,600,700}.woff2` (Latin) | [`@fontsource/chakra-petch`](https://www.npmjs.com/package/@fontsource/chakra-petch) 5.3.0, © 2018 The Chakra Petch Project Authors | OFL-1.1, [`OFL-ChakraPetch.txt`](./OFL-ChakraPetch.txt) |

## 中文简介

赛博朋克是 Capybara 官方的展示插件，把界面变成“赛博朋克水豚”：深蓝黑底、霓虹黄强调色、青色辉光、
切角边框，界面字体 JetBrains Mono、正文字体 Chakra Petch（仅拉丁字符，中文回落到内置字体），霓虹像素
水豚标志，字标为 `CYBERBARA`。

- **主题（L0）**：只有深色一种配色，通过全部对比度与分隔度下限。
- **组件（L1-L2）**：对话属性面板里的运行 HUD（运行状态 待命 / 运行中 / 等待输入 / 故障、本次运
  行用时 `T+` 计时、均衡器式信号条、操作员角色、上行时间、本标签页实时看到的运行 / 工具调用 / 审
  批次数（还没看到时显示“—”）、音效开关）；覆盖层的扫描线与不透明的终端启动画面（每次登录一次，约两
  秒，像显像管关机一样收成一条线结束）；侧栏品牌位的故障风字标；新对话页的赛博朋克欢迎区。
- **装饰（L3）**：卡片、统计卡片、分区、对话框、菜单、代码块、用户消息气泡、输入框、按钮、分段控件、
  智能体标签、开关与组织首字母块切角（`corner-shape: bevel`，边框与焦点环沿斜边连续）；焦点统一为霓
  虹黄；开关滑块改为方形且关闭时清晰可辨，组织首字母块改为霓虹标签，选中的智能体标签用霓虹描边；所有
  规则都经 `:root:has(…)` 生效，对话框、菜单、⌘K、属性抽屉与侧栏抽屉同样适用。
- **运行动效**：运行中标题栏底边有亮光扫过，HUD 信号条像均衡器一样跳动，正在生成的回复上有扫描光束与
  带轻微故障效果的“写入头”，输入框边框上有一道光绕行；等待输入时整体青色缓慢呼吸；失败时红色闪一下故
  障，随后保持红线与平直的信号条。只动 transform 与 opacity，不引起布局变化；光束、写入头与输入框光
  效是回复和输入框自身的伪元素，运行之外不做任何计算，打开的抽屉或对话框会自然盖住它们；扫描线保持静
  止，不随运行变化。

全部装饰只在选用本主题时生效；换成别的主题后，品牌位与欢迎区回到内置样式。音效用 Web Audio 合成，
**默认关闭**，在 HUD 里点“音效：关 / 开”开启（只对本浏览器生效）。系统开启“减少动态效果”时不播放
启动画面与运行动效、停止所有动画（颜色与线条保留），也不播放音效。覆盖层只做装饰，不接收鼠标事件，
启动画面约两秒后自动结束，可点“跳过”或按 Esc 立即结束。

验收：超级管理员导入插件并批准权限（`permissions.client` 与各 `ui.component:*` 为敏感权限），在插件
详情页点“应用此插件的外观”，即把平台默认主题设为赛博朋克，并把 `shell.brand`、`conversation.empty`
换成本插件的组件，页面随后重新加载。`?safe-ui=1`、关闭“插件界面代码”或停用插件会移除全部组件、
覆盖层与插件样式，但 L0 主题（配色、字体、霓虹标志）仍然生效，因为主题是声明式的，不属于客户端代码；
要回到官方外观，在外观设置里换成别的主题。
字体均为 SIL OFL 1.1 授权，许可证全文随插件分发。
