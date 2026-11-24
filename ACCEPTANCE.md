# ACCEPTANCE — 划选即 Fork

## 第二轮：两处缺陷修复（2026-11-19，任务书 `BRIEF_fork_fixes.md`）

环境：OpenCode Desktop 2.3.0，插件 SDK `@opencode/plugin@2.3.0`。改动只在 `src/gui.tsx`，**必须重启桌面端才生效**（桌面端只在启动时加载插件 GUI）。

### 修了什么

**缺陷一：Fork 在鼠标未松开时就出现。**
- 原因：旧逻辑每次 `selectionchange` 都评估选区，拖拽中只要过 250ms 宿主浮条还没出现，就弹出自绘浮条；宿主浮条要松手后才出现，于是 Fork 先单独出现，再并入。
- 修法：左键在页面上按下即进入拖拽态，立刻隐藏 Fork；拖拽期间 `selectionchange` 一律隐藏。松手（`mouseup`，或窗口失焦）后才评估选区。宿主浮条在则并入；不在则等 400ms 再用自绘浮条兜底。按在 Fork 按钮或宿主浮条上不算拖拽，所以点 Copy、点 Fork 不受影响。
- 依据：宿主 2.3.0 的浮条状态机在 `pointerup` 后再等 150ms 才量选区并挂浮条（`.research/app/out/renderer/assets/route-CFe3GUyJ.js`，`BO()` 与 `settle.schedule` 的 `setTimeout(…,150)`）。旧的 250ms 兜底离这个时间太近，所以改成 400ms。

**缺陷二：面板空白。**
- 原因：面板首帧读 `permissions().length`。宿主的 `data.session.permission.list(id)` 在 `permission.sync` 完成之前返回 `undefined`，虽然类型声明是数组。所以抛出 `TypeError: Cannot read properties of undefined (reading 'length')`，整个 Panel 渲染中断。
- 证据：桌面端 2.3.0 包内的实现是 `permission:{list(e){return c.session.permission[e]}`，没有兜底；同一文件里 `message.list` 是 `…message[e]??[]`，`status` 是 `…active[e]??"idle"`，这两个都有兜底（`.research/app/out/renderer/assets/main-CEQaLS28.js`；npm 包 `@opencode/client` 的 `dist/chunks/contract-tztyfz1b.js` 第 1636 行也一样）。`messages()`、`info()`、`running()` 都不会返回 undefined，只有这一个源有问题。
- 修法：`permissions()` 在数据源处给出明确初值 `[]`，并注明宿主的这个行为。另外补了两种文案：消息首次同步完成之前显示「加载中…」；同步完成后仍然没有消息，显示空态「这个分叉还没有消息，可以在下方输入。」。旧版在没有消息时会一直显示「加载中…」。

### 验收结果

| # | 验收项 | 结果 |
|---|---|---|
| 1 | 按住鼠标拖选的全过程中 Fork 不出现 | **待用户重启后点验** |
| 2 | 松开、宿主浮条出现后，Fork 与 Copy 并列出现 | **待用户重启后点验** |
| 3 | 点 Fork，面板完整：标题行、消息列表、输入框 | **待用户重启后点验** |
| 4 | 面板消息与标签页里一致 | **待用户重启后点验** |
| 5 | 面板发送一句，回复流式输出，按钮状态变化 | **待用户重启后点验** |
| 6 | 无消息的分叉显示空态，不白屏 | **待用户重启后点验** |
| 7 | 重启后上述全部仍成立 | **待用户重启后点验** |
| 8 | `renderer.log` 不再有 `opencode-session-fork` 的 error | **待用户重启后点验** |
| 9 | 构建与类型检查通过 | **已通过**（输出见下） |

已经验证的（不需要桌面端）：

```
$ npx tsc --noEmit     → rc=0，无输出
$ npm test             → tests 5, pass 5, fail 0
$ npm run build        → dist/gui-experimental.cjs  14.42 kB │ gzip: 5.27 kB  ✓ built
```

- 服务端已经在下发新 bundle：`opencode api plugin.gui --param id=opencode-session-fork` 返回 code 14197 字符、revision `bbf7fab7…`，内容里有 `panel.empty` 和 `mouseup`。桌面端重启后加载的就是这一版。
- 缺陷二用到的分叉会话 `ses_e0bc5c9aeffeZOYGQAjvZcCn3j` 消息结构正常：`GET /api/session/<id>/message` 返回 6 条（assistant ×4、system、user）。assistant 的 `content` 都是数组，tool 的 `state.status` 都有值，面板的消息渲染不会再读到 undefined。

### 待用户重启后点验（每条：怎么操作 → 看什么）

先完全退出桌面端（⌘Q），再重新打开。

1. **拖拽中不出现。** 在任意助手回答里按住左键慢慢拖选，停在中途别松手，停一两秒 → 整个过程中 Fork 不出现，自绘小浮条也不出现。
2. **松手后并列出现。** 接着松开 → 宿主浮条（Copy 等）出现，Fork 在同一条浮条里紧挨着出现，没有先单独闪一下再并入。点 Copy 仍然能复制。
3. **面板完整。** 点 Fork → 右侧开出 Fork 标签，顶部有标题行（`Fork · <原标题>`、「在标签页打开」、×），中间是消息列表，底部是输入框，输入框里是所选文字。
4. **消息一致。** 点「在标签页打开」→ 标签页里的历史和面板消息逐条对应（面板是简化视图，工具只显示一行摘要，宿主自动加的 fork-notice 不显示）。这一步同时验证「在标签页打开」能用。
5. **发送与流式。** 回到面板，改一句短问题按 Enter → 发送按钮先转圈，然后变成「停止」，同时出现「生成中…」，回复逐步长出来；生成结束后按钮变回「发送」。
6. **空态。** 用 Fork 按钮建的分叉至少带着所选那条回答，界面上造不出零消息的分叉，所以用「分叉会话已不在」来触发同一条空态路径：先点一次 Fork，然后在左侧会话列表里删掉这个分叉会话，保留右侧的 Fork 标签，再 ⌘Q 重开 → 恢复出来的 Fork 标签先短暂显示「加载中…」，然后显示「这个分叉还没有消息，可以在下方输入。」，标题行和输入框都在，不白屏。另外，在第 3 步打开面板的瞬间，应该只闪一下「加载中…」，之后就是消息，不会白屏。
7. **重启后仍成立。** 再 ⌘Q 重开一次 → Fork 标签恢复，面板内容完整，1–6 条抽查仍成立。
8. **日志干净。** 在最新的日志目录里执行
   `grep -n "opencode-session-fork" ~/Library/Application\ Support/ai.opencode.desktop/logs/<时间目录>/renderer.log`
   → 没有 `[error]` 行。

证据位置：
- 桌面端日志：`~/Library/Application Support/ai.opencode.desktop/logs/<时间目录>/renderer.log`。修复前的报错在 `logs/20261119T143152/renderer.log` 第 1 行：`[2026-11-19 08:33:38.152] [error] [plugin] opencode-session-fork TypeError: Cannot read properties of undefined (reading 'length')`。
- 修复前的空白面板截图（用户提供）：`~/.openclaw/workspace/media/inbound/openclaw-staged-fc9a7dfc-18fe-4eb2-b311-9728bd3ce351/input-0b38bc9b-6b54-4a50-beb9-3a184597b9bd.jpg`。
- 点验后如果还有问题，把对应时间目录的 `renderer.log` 和截图路径给我，我从那里定位。

---

## 第一轮：初次交付（2026-11-19，任务书 `BRIEF_fork.md`）

> 下面是首轮记录。其中界面层的「未真机验证」各项，已由上面第二轮的点验清单统一接管。

环境：OpenCode Desktop 2.3.0（服务端 `opencode-cli 2.3.0 serve --service`），插件 SDK `@opencode/plugin@2.3.0`，macOS，Node 26.7。

结论：**数据层（2、4、5）和构建（9）已真机通过。界面层（1、3 的界面部分、6、7、8 的运行时部分）还没有真机点验。** 原因：本任务约定不重启桌面端，而当前会话也驱动不了桌面端的渲染层（Electron 没开远程调试，插件只能在桌面端窗口里运行）。服务端已经热加载了插件，并能正常下发 GUI bundle（见第 8 条）。桌面窗口是否已加载，要重载或重启后人工确认，点验清单在文末。

| # | 验收项 | 结果 |
|---|---|---|
| 1 | 划选助手消息文字后，选区旁出现 Fork | **未真机验证**（实现与依赖已核对，见下） |
| 2 | 新会话历史与原会话到该消息为止一致 | **通过** |
| 3 | （改写后）点 Fork 后所选文字作为草稿出现在分叉面板输入框，光标就位可编辑，不自动发送、不触发模型 | **数据侧通过；界面侧未真机验证** |
| 4 | 分叉后不自动跑模型，会话停在空闲 | **通过** |
| 5 | 原会话消息数与内容不变 | **通过** |
| 6 | 两个会话同屏可见，左侧仍可输入；关掉分叉不影响原会话 | **未真机验证** |
| 7 | 重启后功能仍在 | **未真机验证**（配置已持久化，服务端已加载） |
| 8 | openclaw-inbox 徽标、permission-notify 弹窗不受影响 | **服务端实证通过；桌面端运行时未真机验证** |
| 9 | 构建通过，无类型错误 | **通过** |

---

## 1. Fork 按钮出现

- 实现：`src/gui.tsx` 监听 `selectionchange`。只有选区起点和终点都落在同一条助手消息的 `[data-timeline-part-id="<msgID>:(text|reasoning):<n>"]` 内，并且 `server.data.session.message.get()` 确认这条消息是 `assistant` 类型时，才出现 Fork。宿主的 Quote 浮条（`[data-component=timeline-quote]`）出现时，Fork 按钮插到 Quote 后面；250ms 内宿主浮条没出现，就改用自绘浮条，放在选区的右下方或右上方。
- 依赖核对：`[data-component=timeline-quote]` 的模板，以及 part id 的生成规则 `${message.id}:${type}:${n}`，都来自桌面端 2.3.0 包内的 `out/renderer/assets/route-CFe3GUyJ.js`（见 DESIGN_FORK.md 1.1、1.4）。解析规则有单测覆盖：`test/core.test.ts`，`parsePartId`。
- 主题：颜色全部取宿主的 `--v2-*` 变量并带 fallback（`src/style.css`）。深浅色效果需要真机看。

## 2. 历史一致（真机通过）

方法：`scripts/verify-fork.ts` 按插件的调用顺序依次执行：按新到旧分页 `message.list` 找截断点（`boundaryIn`），然后 `session.fork`、`session.update`。之后用 `opencode api get /api/session/<id>/message` 逐条比对。比对时去掉 `id` 和 `time`，其余字段完全相同才算一致。

测试原会话 T 有两轮对话，共 6 条记录：user、assistant、idle、user、assistant、idle。

| 组 | 所选助手消息 | 计算出的 `before` | 原会话条数 | 原会话到所选消息为止 | 分叉会话条数 | 逐条一致 | 分叉末条就是所选消息 |
|---|---|---|---|---|---|---|---|
| 长历史中间 | 第 1 轮 assistant `msg_1f4244cd9…` | `msg_1f424572c…`（idle） | 6 | 2 | 2（user、assistant） | true | true |
| 最后一轮 | 第 2 轮 assistant `msg_1f4245d80…` | `msg_1f424638c…`（idle） | 6 | 5 | 5（user、assistant、idle、user、assistant） | true | true |

选中的片段在长消息中间时，整条助手消息原样保留，`content` 完全一致。

## 3. 草稿（改写后的标准）

- 改写原因：真机核实 `prompt({resume:false})` 写入的消息停在 inbox，不进 `/message`。按约定改成草稿方案，验收标准已经和铭培确认（DESIGN_FORK.md 第 6 节）。
- 数据侧（通过）：两组分叉之后，`forkHasUserMessageAfterHistory=false`，也就是说分叉会话里没有写入任何用户消息。inbox 里只有宿主自动放入的 `msg_fork_notice_<id>`（synthetic），没有用户输入。
- 界面侧（未真机验证）的实现：`fork()` 成功后先 `draft(id).set(选中文字)`，选中文字只去掉首尾空行，单测 `draftText` 覆盖。然后 `ctx.layout.open("<plugin>:fork-<id>", 原会话)`。面板的 textarea 挂载后，在下一帧 `focus()`，并把光标放到末尾。

## 4. 不自动跑模型（真机通过）

- 每组分叉完成后，`GET /api/session/active` 里都没有这个分叉会话（`forkRunning: null`）。
- 代码核对：`grep -n "prompt(\|resume" src/gui.tsx` 只命中第 274 行，就是面板「发送」按钮里的 `data.session.prompt`。Fork 流程里没有任何写消息的调用。
- 另外，标题在 fork 之后立刻用 `session.update` 设好，原本是想避免服务端按首条消息自动生成标题而产生模型调用。

## 5. 原会话零副作用（真机通过）

两组分叉前后，原会话 T 的快照完全一致：

```
before: count 6, sha 84c0a05f492ac441, title "[fork-test] T", time {created 1795097376087, updated 1795097387914, busy 1795097386364, idle 1795097387916}
after : count 6, sha 84c0a05f492ac441, title "[fork-test] T", time {created 1795097376087, updated 1795097387914, busy 1795097386364, idle 1795097387916}
```

另外，在一个分叉会话里实际发了一次追问，模型正常作答，分叉会话共 9 条。之后原会话依然是 6 条，`time` 不变。

## 6. 同屏、左侧可输入、关闭不影响原会话

- 实现：分叉以侧栏 Panel 标签的形式挂在**原会话**的侧栏标签条上，初始宽度约为窗口的 45%，最小 360px，用户可以拖动。左边是宿主自己的原会话界面，插件不碰它的输入框。关闭用宿主的标签关闭按钮，或者面板右上角的 ×，都会调用 `ctx.layout.close`，不删除分叉会话，也不写原会话。
- 未真机验证。

## 7. 重启后仍在

- 配置已经写进 `~/.config/opencode/opencode.jsonc` 的 `plugins` 数组，服务端 `plugin.list` 显示 `opencode-session-fork` 为 `active`，`features.gui=true`。Panel 没有设 `transient`，宿主会还原标签，`list()` 按存下来的 `fork-<id>` 把标签恢复出来。
- 已知限制：重启后，还没发送的草稿会丢。
- 未真机验证，因为本任务约定不重启。

## 8. 其他插件不受影响

服务端实证：安装前后 `opencode api plugin.list` 中三个非内置插件的条目完全一致，都是 `active`：

```
before/after: opencode-openclaw-inbox  local …/openclaw-inbox     features {gui: true}    state active
before/after: permission-notify        local …/permission-notify  features {server: true} state active
before/after: dict-lookup              local …/dict-lookup        features {gui: true}    state active
after only:   opencode-session-fork    local …/opencode-session-fork features {gui: true} state active
```

服务端能正常下发本插件的 GUI bundle：`plugin.gui id=opencode-session-fork` 返回 code 13609 字符、revision `0cc7aa6a…`。

配置改动只是在 `plugins` 末尾追加了一个条目，`diff` 如下：

```
76c76,79
<     "./local-plugins/dict-lookup"
---
>     "./local-plugins/dict-lookup",
>     // 2026-11-19：划选即 Fork（…）。回滚：删掉这一行
>     "/Users/mingpeiwang/Desktop/Code工作区/opencode-session-fork"
```

openclaw-inbox 的 `options`（`header: false, tray: false`）没有改动。注意：这个配置本来就把标题栏徽标关掉了（2026-11-17 起入口改到「案头」），所以界面上现在本来就看不到徽标。

隔离性（按代码核对）：本插件只注册 `Style` 和 `Panel(region: "side", id: "fork")`，不注册 `session.header` Slot、`TitlebarItem`、主进程入口、`context-menu`，也不使用原生模块，和 openclaw-inbox、permission-notify、dict-lookup 用到的扩展点都不重叠。

桌面端运行时（未真机验证）：重启后看第 9 步。

关于「其他插件仓库没动」：本任务期间没有对 openclaw-inbox、permission-notify 仓库做任何写操作，只在阶段一经授权读过一次。阶段二再访问这些路径会触发授权弹窗，按约定没有再去核对 `git status`。`/Applications/OpenCode.app` 同理：阶段一解包前后 `app.asar` 的 sha256 都是 `f172c177be6394cf98784d3468298fbb6f1ec2112b8a64167dcd2a9ecb244e1f`，阶段二没有访问。人工复核命令见 HANDOFF.md。

## 9. 构建与类型检查（通过）

```
$ npx tsc --noEmit            → rc=0（无输出）
$ npm test                    → tests 5, pass 5, fail 0
$ npm run build               → vite v7.3.8 … dist/gui-experimental.cjs  13.79 kB │ gzip: 5.06 kB  ✓ built
bundle 外部依赖只有 @opencode/plugin/gui、solid-js、solid-js/web（都由宿主提供）
```

## 测试会话清理

本任务一共建了 5 个测试会话：原会话 T `ses_e0bdbcaa9ffe…`，分叉 `ses_e0bdb64b3ffe…`、`ses_e0bcb760affe…`、`ses_e0bcb744effe…`、`ses_e0bcb4490ffe…`。已逐个 `session.remove`，再 `GET` 都返回 `SessionNotFoundError`，`session.list` 里也没有残留的 `fork-test` 会话。

---

## 真机点验清单（桌面端下次重启或重载后，人工 5 分钟）

1. 打开任意一个有助手回答的会话，划选回答中间的一段文字。Quote 旁边应该出现「Fork」，深色和浅色主题各看一次。
2. 点 Fork。右侧侧栏应该打开一个 Fork 标签，标题是 `Fork · <原标题前 20 字>`，历史到这条回答为止，输入框里是所选文字，光标在末尾，模型没有在跑。
3. 在左边原会话的输入框打几个字，确认能正常输入。在右边按 Enter 发送，确认能得到回答。
4. 关掉 Fork 标签，原会话不变。
5. 用 `opencode api get /api/session/<原会话id>/message` 核对条数：分叉前后应该一致。
6. 重启 OpenCode，分叉标签应该还在，Fork 按钮仍然可用。
7. 触发一次需要授权的操作，确认 permission-notify 的右上角浮窗照常弹出。在 openclaw-inbox 的「案头」打开一个 🦞 任务，确认照常工作。


## 第四轮真机验收（2026-11-21 22:25，用户确认）

用户在设计会话仍在运行、**没有重启桌面端**的情况下直接试用，确认三处改动都已生效并且满意：

- 输入框压到一行，选中文字不再进输入框。
- 选中文字以引用卡片出现在输入框上方。
- 历史里的执行链折成一行、点击展开。

结论：本插件记为结案。**实测支持热插**——`npm run build` 之后不需要重启桌面端，界面即加载新 bundle，此前 HANDOFF 里「生效需要重启桌面端」的说法对 GUI 部分不成立，后续改版可以省掉这一步（若改到主进程或面板注册表，仍需重启）。

遗留观察项：`renderer.log` 在 22:07 有一条 `Uncaught RangeError: Maximum call stack size exceeded`，时间接近面板操作，但无法确认归属。若复现再查，不影响本次结案。

---

## 第五轮真机验收（写回）（2026-11-23，任务书 `BRIEF_FORK_WRITEBACK.md`）

背景：关闭 Fork 时受控写回。实现口径先记一笔，点验时对照——确认弹窗在摘要生成**之后**出现（生成失败就不弹、直接跳过）；写入的是 `session.synthetic({resume:false})`，不触发模型；写回行在宿主时间线里显示为「来自 Fork · <标题>」，点击展开三段详情和「回到 Fork」。

准备：重启桌面端（第四轮实测热插有效，可先只关窗口重开；保险起见 ⌘Q 完全重启）。记下 `~/Library/Application Support/ai.opencode.desktop/logs/` 下最新的时间目录，每步之后查它的 `renderer.log`。

| # | 操作 | 判断标准 | 结论 |
|---|---|---|---|
| 1 | 找一个会话，划选一条助手回答 Fork 出来，在 Fork 里让它**改一个文件**（例如「把 src/a.ts 的 X 改成 Y」），等它改完，关掉 Fork 标签 | 弹出「并入主线？」确认框；选「并入」后，左侧原会话时间线里出现一行「来自 Fork · <标题>」（时间线是折叠档位时可能折在一条 group 里，点开 group 可见）。点这一行，展开出三段：**结论**（两三句）、**改动**（文件路径 + 一句说明）、**还悬着**，合计不超过 300 字；行尾有「回到 Fork」按钮，点了能重新打开这个 Fork 的面板。原会话没有开始生成、没有产生任何模型回复 | |
| 2 | 紧接着点「回到 Fork」再把这个 Fork 关一次；重启桌面端后再打开这个 Fork 关一次 | 不再弹确认框，原会话没有第二条写回；`renderer.log` 里各有一行 `[session-fork] writeback skipped (<forkID>): already written` | |
| 3 | 重新 Fork 一个会话，在 Fork 里改一个文件（或发新消息），关闭，弹窗时选「不并入」；然后原样再关一次 | 选否后原会话没有任何新增（可用 `opencode api session.message.list --param sessionID=<原会话ID>` 对比条数）；再关一次不再弹窗。此后在 Fork 里**再发一条新消息**，关闭时才会再次询问 | |
| 4 | Fork 一个会话，在 Fork 里只问一个问题（例如「这段是什么意思」），等回答，不改任何文件，关闭 | 不弹确认框，原会话没有任何新增，`renderer.log` 有一行 `writeback skipped (<forkID>): no changes and no conclusion`（或 `nothing happened in the fork`） | |
| 5 | 断开网络（关 Wi-Fi），关闭一个改动过文件的 Fork | 关闭动作立即完成、无卡顿、不弹窗（摘要生成失败即跳过）；`renderer.log` 有一行 `[session-fork] writeback skipped (<forkID>): summary failed: …`；恢复网络后一切正常 | |

结论：**主流程真机通过（2026-11-24 17:32，铭培在新会话实测）**。关闭 Fork 后弹出确认，确认后主会话出现「来自 Fork · <标题>」的可展开条目，三段齐全。第 2 至第 5 项（重复关闭不重写、选否不写、无改动不写、断网跳过）未逐项点验，由 32 条测试与代码路径覆盖，后续遇到再补。

**同轮修的两个真实故障**
1. 摘要模型报 `Model not found: deepseek/deepseek-flash`。根因是插件在默认目录上下文里解析模型，而不是 Fork 所在目录。改为在 Fork 自己的目录解析，并在变体被拒时去变体重试一次（`0a66071`）。
2. 手动注入写回时元数据结构套错一层（`{sessionFork:{...}}`），插件按「source + forkID + hash」平铺字段识别，认不出就退化成普通通知，只显示一行。正确结构见 `src/writeback.ts` 的 `WritebackMeta`。
