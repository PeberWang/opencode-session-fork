# DESIGN_FORK — 划选即 Fork：可行性判定与方案

结论：**不需要改宿主包体，可以做。** 实现分两块，都只用插件能拿到的东西：

- Fork 按钮通过 DOM 层注入。宿主没有选区菜单的注册点，只能依赖几个渲染层 DOM 属性，失效时会悄悄不出现，不会把宿主弄坏。
- 并排显示用官方的侧栏 Panel，在右侧自己画一个分叉会话视图。宿主没有把两个会话同屏并列的 API。

数据层（fork、改标题、把选中文字作为引用随消息发出但不跑模型）全部走官方 client API；第五轮关闭时的写回另走 `session.synthetic` 与 `experimental.generate.text`（见 README）。

推荐方案 A（见第 4 节）。

---

## 0. 事实校正（与任务书不一致的地方）

| 任务书 / CLAUDE.md | 实测 | 影响 |
|---|---|---|
| OpenCode v2.2.7 | 桌面版 `/Applications/OpenCode.app` 的 `CFBundleShortVersionString` 是 **2.3.0**，内置 `opencode-cli` 也是 2.3.0，服务进程是 `…/ai.opencode.desktop/cli/2.3.0-arm64/opencode-cli serve --service`。只有 homebrew 的 `opencode` CLI 还是 2.2.7 | 阶段二应依赖 `@opencode/plugin@2.3.0`。我对比过 2.2.7 和 2.3.0 的 `dist/gui/registries.d.ts` 与 `host-apis.d.ts`，注册表和接口列表完全一致，结论不变 |
| 划选只出现 Copy | 宿主 2.3.0 的划选浮条只有一个按钮：**Quote**（`session.quote.add`，图标 `outline-quote`）。本机的 `~/.config/opencode/local-plugins/dict-lookup` 会在右键时弹一个原生菜单，内容是「查询“…” / 拷贝」 | 他看到的 Copy 多半是 dict-lookup 的右键菜单，需要他确认一下。方案不往原生右键菜单里加东西，理由见 2.3 |

## 1. 消息选区的浮动菜单在哪里实现

### 1.1 位置

解包 `app.asar`（只读，解到 `.research/app`，原包 sha256 在分析前后一致：`f172c177…244e1f`）。渲染层在 `out/renderer/assets/`。

- **chunk**：`route-CFe3GUyJ.js`（会话路由页，约 700KB。文件名带哈希，每次发版都会变）。
- **状态机**：函数 `fk({root, sessionKey, enabled, add})`。它监听 `document` 的 `selectionchange`、`pointerdown`、`pointerup`、`keydown`、`scroll`，状态有 idle、shown、dismissed，产出 toolbar 的位置（`bounds` / `extent`）。
- **渲染组件**：`pk({controller})`，模板是：
  ```html
  <div data-component=timeline-quote data-prevent-autofocus role=toolbar
       class="fixed z-50 flex items-center gap-0.5 rounded-[8px] p-0.5 shadow-[var(--v2-elevation-raised)]">
  ```
  里面硬编码了一个 `Qe`（Button）：`size:"small", variant:"ghost", icon:"outline-quote"`，`onClick: e => n.add(e.altKey)`，文字是 `t("session.quote.add")`，即「Quote」。根节点上有 `$$mousedown = e => e.preventDefault()`，这样点按钮时选区不会丢。
- **挂载点**：会话页里是 `let ue = fk({root: y.scroller, …, enabled: () => v() && le.quote.available(), add: le.quote.add})`，再在页面层渲染 `F(pk, {controller: ue})`。只有当前会话的输入框能接受引用（`quotable`）时才会出现。

### 1.2 Copy 怎么挂的

宿主的浮条上没有 Copy。复制靠的是 ⌘C 和 Electron 默认行为，时间线根节点上还有 `copy` 事件的改写（`Gl()`，用来把渲染后的文本还原成 Markdown 源码）。右键出现的「拷贝」来自 dict-lookup 插件，它在主进程里 `webContents.on("context-menu")`，并且**只在没有别的 context-menu 监听者时才接管**。

### 1.3 注册点

**没有。** 证据：

- `@opencode/plugin@2.3.0/dist/gui/registries.d.ts` 里，`MenuItem.menu` 只有 `session.panel | server.add | server.row`。`SlotMap` 只有 `window.bottom | session.header | session.location.menu | session.panel.end`。其他注册表还有 Command、Panel、SettingsPage、Server、LinkHandler、TitlebarItem、ComposerPill、CodeBlock、CodeBlockAction、Slot、Style、Theme。全文搜 `selection` / `quote` / `timeline`，命中的只有文档注释。
- `pk` 的子节点是写死的，不读任何注册表。

### 1.4 选区到消息 ID 的映射（Fork 要用）

- 助手文本片段的 DOM 节点带 `data-timeline-part-id`，值来自 `ks.contentEntries(message)`：
  `id = part.type === "tool" ? part.id : \`${message.id}:${part.type}:${序号}\``
  所以文本片段的 id 形如 `msg_xxx:text:0`，从选区起点 `closest("[data-timeline-part-id]")` 取到后，`split(":")[0]` 就是**助手消息 ID**。API 里的文本片段本身没有 id，这一点已用 `opencode api get /api/session/<id>/message` 核实。
- 行容器带 `data-timeline-row="AssistantPart"`。行上的 `data-message-id` 是**这一轮的用户消息 ID**，不是助手消息 ID，不能拿来用。

## 2. 能否不动 app.asar 把 Fork 加到菜单

**能，但只能走 DOM 层。** GUI 插件的 `setup` 和宿主跑在同一个渲染进程、同一个 `document` 里（openclaw-inbox 就在用），所以可以直接操作 DOM。

### 2.1 首选：并入宿主的 Quote 浮条

用 `MutationObserver` 观察 `document.body`。出现 `[data-component=timeline-quote]` 时，往里追加一个由插件自己创建的 Fork 按钮。

- 位置、深浅色、阴影、跟随滚动都由宿主负责。浮条用 ResizeObserver 量自身宽度，所以加了按钮后会自动重新定位。
- 根节点的 `mousedown preventDefault` 也作用在我们的按钮上，点下去时选区还在。
- 按钮样式取宿主的 CSS 变量（`--v2-text-*`、`--v2-background-*`），深浅色自动跟随。用 `ctx.add(Style, css)` 注入，插件卸载时自动撤掉。
- 只在选区起点和终点都位于同一个**助手**片段（`:text:` 或 `:reasoning:`）里时才显示。

### 2.2 兜底：自绘浮条

浮条不出现时自己画一个：比如输入框不可引用（这时宿主 `enabled=false`），或者升级后 `data-component` 改了名。做法是在 `selectionchange` 停下约 150ms 后检查，如果选区在助手片段里、又找不到宿主浮条，就在选区矩形旁边放一个 `position: fixed` 的小浮条，样式同上。

### 2.3 不选的路线

- **原生右键菜单**：主进程的 `context-menu` 只能拿到 `selectionText`，拿不到消息 ID，还得再走一次 IPC 回渲染层。另外它会和 dict-lookup 互相干扰：dict-lookup 发现已有监听者就不接管，加载顺序一变，要么菜单弹两层，要么词典功能消失。CLAUDE.md 不允许改 dict-lookup，所以不碰。
- **改 `pk` 组件**：需要 patch asar，排除。

### 2.4 依赖的宿主内部约定（升级风险清单）

| 依赖 | 失效时的表现 | 缓解 |
|---|---|---|
| `[data-timeline-part-id]` 及其 `<msgID>:<type>:<n>` 格式 | 拿不到消息 ID，Fork 不出现 | 兜底：拿选中文字去匹配 `data.session.message.list()` 里的助手文本（数学公式渲染后文本对不上时会失败）。仍失败就不显示，并记一条 `console.warn` |
| `[data-component=timeline-quote]` | 不能并入 Quote 浮条 | 自动改用自绘浮条（2.2） |
| `--v2-*` CSS 变量 | 颜色回退 | CSS 里写上 fallback 值 |

这些都只影响按钮出不出现，不会让宿主报错，也不影响其他插件。

## 3. 两个会话能否在一个窗口里并排

**宿主没有这样的 API。** 证据：

- `Layout` 只管侧栏标签（`open/close/toggle/hide/state/stored/side.*`）、滚动、设置和项目对话框、`draft`。
- `Tabs.open` 是在顶部标签条里切换，同一时刻只显示一个会话。
- `Ui` 组件只有 Icon、Button、IconButton、Tooltip、Menu、MenuItem、MenuSeparator、MenuGroup、MenuSub、Loader、Dialog、Switch、TextInput、Keybind、Markdown、Code，以及三个 Settings 组件，**没有会话时间线组件，也没有输入框组件**。
- `Embeds` 可以把 WebContentsView 放进面板，但要再加载一份宿主渲染层（`oc://renderer/…`）。那份渲染层需要宿主内部的 preload（`out/preload/index.cjs`）、`additionalArguments`，还要在主进程的窗口表里登记，这些都是内部实现，插件没有正规途径。排除。
- 新窗口只能走主进程菜单 action `window.new`（`MenuRunAction` IPC，内部），插件 API 里没有。

下面是可行的替代。

### 3.1 侧栏 Panel 挂一个自绘的分叉会话视图（全部用官方 API）

- `ctx.add(Panel, { region: "side", … })`。Fork 完成后调用 `ctx.layout.open("<plugin>:fork-<forkID>", 原会话)`，标签挂在**原会话**的侧栏标签条上。左边是宿主的原会话（输入框照常可用），右边是分叉。
- 消息流：`server.data.session.message.list(forkID)` 和 `status(forkID)` 是响应式的，流式输出自动刷新。文本用 `ctx.ui.Markdown` 渲染，它和时间线是同一套渲染器，支持数学公式和代码块。推理与工具调用按宿主的 compact 形态折成一行分组（`src/timeline.tsx`，第四轮补上展开详情），见 HANDOFF「执行链按宿主原版重画」。
- 输入框：自己画一个单行可增长的 textarea（第四轮定稿，默认一行、最多 6 行）。Fork 完成后聚焦这里；所选文字以引用卡片显示在输入框上方，点 × 可移除。发送走 `data.session.prompt({sessionID: forkID, text, metadata})`，引用按宿主 composer 的 `QuoteComment` 写成正文前缀加 metadata 两份（第四轮）。另有「停止」（`session.interrupt`）和「在标签页打开」（`ctx.tabs.open({…}, {focus: true})`，切到宿主的完整界面）。
- 关闭：关掉侧栏标签即可，分叉会话留在服务端，会话列表里能找到，**不自动删除**。原会话在分叉期间不受影响；关闭时按「受控写回」口径（`BRIEF_FORK_WRITEBACK.md`）经用户确认后写回一条摘要，见 README「Write-back」。
- 重启：Panel 不设 `transient`，宿主会还原标签，`list()` 按存下来的 id 把标签恢复出来。
- **体验代价**：右边是简化视图。没有宿主的工具卡片、diff、模型或 agent 选择器、附件、斜杠命令。出现权限请求时只提示「去标签页处理」（permission-notify 照常弹通知）。侧栏宽度由宿主管理，用户可以拖动，插件用 `Panel.width` 给一个初始宽度，约窗口的一半。

### 3.2 分叉会话作为宿主普通标签页打开（不并排）

- `ctx.tabs.open({server, id: forkID}, {focus: true})`，打开后就是宿主的完整界面。
- **体验代价**：不并排，要在标签之间来回切换，不满足「左原右分叉」。

### 3.3 第二窗口，插件把两个窗口摆到左右半屏

- 主进程入口里需要用 `Menu.getApplicationMenu()` 找到「New Window」菜单项并 `click()` 来新开窗口（标签会本地化，菜单项也没有稳定 id）。还要通过同步存储告诉新窗口里的插件实例去 `ctx.tabs.open` 分叉会话，最后用 `BrowserWindow.setBounds` 按 `screen.workArea` 一左一右摆好。
- **体验代价**：两边都是完整界面，但每个窗口都有自己的侧栏和标签条，半屏时很挤。窗口宽度小于 768px 时宿主会切成窄屏布局。关闭靠关窗口，重启后宿主可能把第二个窗口也恢复出来。焦点在两个窗口之间切换。
- **稳定性**：依赖菜单结构、新窗口创建时序、跨窗口握手，三处都是内部行为，升级最容易出问题。

## 4. 方案排序

判据按任务书的顺序：稳定性 > 接近他描述的体验 > 实现省事。

| 排名 | 方案 | 稳定性 | 体验 | 实现量 |
|---|---|---|---|---|
| **A（推荐）** | Fork 按钮并入 Quote 浮条，带自绘浮条兜底；分叉会话放在**原会话右侧的侧栏 Panel** 里，用自绘视图（3.1），并附「在标签页打开」 | 高。并排部分全是官方 API，只有按钮依赖 2.4 列出的 DOM 约定，失效时只是不出现 | 最接近「左原右分叉，右边追问，问完关掉」。代价是右边是简化视图 | 中 |
| B | 同样的 Fork 按钮，分叉会话**直接以宿主标签页打开**（3.2） | 最高，和 A 一样只依赖按钮的 DOM 约定 | 不并排，要切标签 | 小 |
| C | 同样的 Fork 按钮 + **第二窗口左右半屏**（3.3） | 低。菜单 click、窗口时序、跨窗口握手都是内部行为 | 两边都是完整界面，但半屏拥挤，窗口管理繁琐 | 大 |

**推荐 A 的理由**：

1. A 和 B 一样稳。两者共用的 Fork 按钮是唯一依赖内部约定的部分，并排靠的是官方的 Panel 和 data API。
2. 只有 A 做到了同屏并排，而且左边原会话的输入框完全不受影响。
3. 右边视图不够用时（要看工具细节、处理授权），一键「在标签页打开」就退回 B，所以 B 实际上被包含在 A 里。
4. C 用拥挤和脆弱换「两边都是完整界面」，对数学讨论这种以文字和公式为主的场景不划算。

## 5. Fork 行为设计（阶段二按此实现）

1. **定位**：从选区起点取 `data-timeline-part-id`，得到助手消息 ID `M`，会话 ID 取 `ctx.sessions.current()`。选区落在我们自己的 Fork 面板里时不响应，不做多级分叉。
2. **截断点**：`client.session.fork({sessionID, before})` 的语义是「复制 `before` 这条消息**之前**的投影历史；不传 `before` 就复制全部」（服务端路由描述原文：*Create a child session by copying projected history before a message. Omit before to copy the full history.*）。所以 `before` 取原会话里排在 `M` 之后的第一条消息的 ID；`M` 是最后一条时不传。这一步需要真机核实 `before` 指向 idle 之类非对话记录时的行为（见第 6 节），选区所在的那条消息要完整保留。
3. **标题**：`client.session.update({sessionID: fork, title: "Fork · " + 原标题前 20 字})`。要在写入用户消息**之前**设好，避免宿主或服务端按首条消息自动生成标题，那也是一次模型调用。
4. **所选文字作为草稿（2026-11-19 定稿，取代原来的 `prompt({resume:false})` 方案；2026-11-21 第四轮改为输入框上方的引用卡片）**：真机核实发现 `resume:false` 写入的用户消息停在 inbox 里排队，不进 `/message`（见第 6 节）。所以最初改为把选中文字（只去掉首尾空行）直接作为正文放进 Fork 面板输入框的草稿，不调用任何写消息的接口。第四轮起改为引用卡片：输入框留空，选中文字作为宿主同款 quote 随用户自己的消息发出（正文前缀 + `QuoteComment` metadata 两份，见 HANDOFF）。两种做法都不在 Fork 时写用户消息；导出导入的 experimental 接口为了稳定性没采用。
5. **不跑模型**：Fork 流程只有 `message.list`（读）、`session.get`（读）、`session.fork`、`session.update`（只改分叉会话的标题）四个调用。整个插件里唯一的 `prompt` 调用在面板的「发送」按钮里。
6. **原会话零副作用（Fork 期间）**：Fork 流程只做读操作和对原会话的 `fork` 调用，不对原会话做任何写操作。阶段二会核对原会话分叉前后的消息数、内容哈希、标题和 `time.updated`。（第五轮起增加「关闭时受控写回」：只在关闭 Fork、经用户确认后，才向原会话写一条摘要，见 README「Write-back」；Fork 期间口径不变。）

## 6. 真机核实结果（2026-11-19，测试会话已全部删除）

| 项 | 结果 |
|---|---|
| ① `prompt({resume:false})` | 不跑模型、会话保持空闲，但消息停在 `/inbox`（delivery 为 steer），**不进 `/message`**，要等下一次执行才收进历史。**不采用**，改为第 5 节第 4 条的草稿方案（已经和铭培确认） |
| ② `before` 指向 idle 记录 | 正确。分叉复制的是原会话到所选消息为止的**全部记录**，包括轮次之间的 idle；`before` 指向的那条及之后的记录不复制 |
| ③ 分叉会话的形态 | `parentID: null`，带 `fork: {sessionID, boundary}` 字段，标题默认是 `<原标题> (fork #n)`，之后由插件覆盖。可以正常 `prompt`，追问、回答都正常 |
| ④ 原会话副作用 | 两组分叉前后，原会话的消息数、全量内容哈希、标题、`time` 全部一致 |
| 附 | 服务端内置插件 `opencode.fork-notice` 会在分叉会话的 inbox 里放一条 synthetic 类型的 `<fork-notice>`，用户第一次发送时一起收进历史，告诉模型这是一个分叉。属于宿主行为，面板不显示 synthetic 消息 |

## 6.1 实现中自行定下的取舍（都按稳定性优先）

- 面板里的消息按 `time.created` 排序，再按 id 排（复制来的消息保留原时间，id 以数字 `_n` 结尾）。
- 草稿只保存在当前窗口的内存里。桌面端重启后分叉面板会恢复，但还没发送的草稿会丢。持久化需要引入 effect Schema 存储，这是最小实现之外的东西，暂不做。
- 不注册原生右键菜单，不改宿主的 Quote 按钮。
- 分叉面板里的选区不再出现 Fork，不做多级分叉。

## 7. 对其他插件的影响

- **openclaw-inbox**：用的是 `session.header` Slot 和菜单栏，A 方案不碰这两处。
- **permission-notify**：主进程原生模块加授权通知，A 不碰。分叉会话里出现的授权请求照常由它弹通知。
- **dict-lookup**：A 不注册 `context-menu`，不影响它接管右键。
- **宿主 Quote**：只往浮条里追加按钮，不改 Quote 按钮本身，也不改它的事件。

## 8. 交付物与仓库

- 解包产物在 `.research/`，已写入 `.gitignore`，不会提交。
- 阶段二计划结构：照 openclaw-inbox 的脚手架（vite + `@opencode/plugin/gui/vite`，solid），依赖 `@opencode/plugin@2.3.0`，产物 `dist/gui-experimental.cjs`。安装只改 `~/.config/opencode/opencode.jsonc` 的 `plugins` 数组。
