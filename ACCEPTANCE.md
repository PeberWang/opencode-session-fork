# ACCEPTANCE — 划选即 Fork（2026-11-19）

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
