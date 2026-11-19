# HANDOFF — opencode-session-fork（给 OpenClaw）

OpenCode Desktop 的 GUI 插件。在助手消息里划选一段文字，点「Fork」，就会新建一个分叉会话：

- 历史到这条消息为止。
- 标题是 `Fork · <原标题前 20 字>`。
- 分叉会话开在原会话**右侧的侧栏**里，所选文字作为输入框草稿，不会自动发送。

设计与证据见 `DESIGN_FORK.md`，验收见 `ACCEPTANCE.md`。

## 最近一次改动（2026-11-19 第三轮，`BRIEF_fork_fixes3.md`）

**面板发消息后不显示**：根因是宿主的会话保留机制，不在渲染层。
- 宿主对每个服务端调用 `createSessionRetention({ keep: 标签页里的会话, limit: 3 })`，见 renderer `main-*.js` 里 `cJt({session:f.session,…,limit:3})`。
- 不在 keep 里、也不是最近查看过的会话，每当会话列表一变，就会被 `evict`：`store.session.message[id]` 和 `messageIndex` 被删掉，之后的 `step.started`、`text.delta` 也因为找不到索引而全部丢弃。
- 分叉会话只开在侧栏里，所以 Fork 之后第一次会话信息更新（发送后的 usage、状态变化）就会把它清空。首次挂载时 sync 来的历史能看到，就是因为那时列表还没变。关闭再打开会重新 sync，所以能看到最新内容：缺的是订阅，不缺持久化。

改法：
- 面板用宿主提供的 `@opencode/client/solid` 的 `createData` 自建一个私有 Data，挂在同一条宿主事件流（`host.on` / `host.listen`）上。转录读写都走它，发送也走它的 `session.prompt`，所以本地消息立刻出现，回复流式进入同一个 store。
- 宿主的 retention 管不到这个私有实例。会话信息、运行状态、授权仍然读宿主 Data。
- 服务端控制器换代或者重连之后，会重建私有实例并重新 sync，挂载时会把完整历史一次拉齐（`loadMore all`）。
- 回复增长时自动滚到底部；用户往上翻过就不再跟随。

**去掉面板内的叉**：关闭统一交给标签栏。

## 第二轮改动（2026-11-19，`BRIEF_fork_fixes2.md`）

三处缺陷（草稿没进面板、面板的叉关不掉、标签的叉关不掉）是同一个根因：
- 面板里的 fork id 每次都通过 `props.tab` 现读。宿主一删掉标签，`props.tab` 就会抛错（宿主内部是 `entry()!.tab`，见 `panels.tsx`），而我们的 memo 和 cleanup 正在宿主关闭的那一批更新里重跑，于是关闭中途断掉。
- 草稿那一处：Fork 用的是 `tab: "open"`，会复用 preview 槽，顺手把上一个 Fork 标签关掉，走的正是这条抛错路径，把新面板的写入一起打断了。

改法：
- fork id 在挂载时读一次，之后固定不变。
- 打开方式改成 `tab: "select"`，不再顶掉旧的 Fork 标签。
- 草稿改存 `ctx.storage.memory`（插件重载后还在），textarea 挂载时直接把值写进去。
- 关闭标签时清掉该草稿，分叉会话本身留在服务端。

依据是宿主源码的静态分析（`.research/src-extract/`，从包内 sourcemap 抽出），**没有做真机复现**：读 `renderer.log` 的授权请求无人确认。typecheck、test 5/5、build 都通过。生效需要**重启桌面端**。

## 上一次改动（2026-11-19，`BRIEF_fork_fixes.md`）

改了什么（只动 `src/gui.tsx` 和构建产物）：
- **Fork 出现的时机**：按住鼠标拖选期间一律不显示，松手后才评估选区。宿主浮条出现时，Fork 并进同一条浮条，和 Copy 并列；宿主浮条 400ms 内没出现，才用自绘浮条兜底。
- **面板空白**：根因是宿主 2.3.0 的 `data.session.permission.list()` 在同步完成之前返回 `undefined`，面板首帧读它的 `.length`，直接抛错。现在在数据源处给了初值 `[]`。另外补了「加载中…」和空态两种文案。

生效条件：**必须重启桌面端**（⌘Q 再打开）。服务端已经在下发新 bundle，不用另外操作。

已验证：`tsc --noEmit`、`npm test`（5/5）、`npm run build` 都通过；服务端下发的 bundle 是新版；根因已在桌面端包内代码里核实。

待用户重启后点验：ACCEPTANCE.md 第二轮的第 1–8 条（拖拽时序、面板完整、消息一致、发送与流式、空态、重启后仍成立、`renderer.log` 干净）。操作步骤见那一节。

## 安装（已装好）

1. 构建：
   ```
   cd ~/Desktop/Code工作区/opencode-session-fork
   npm install && npm run typecheck && npm test && npm run build
   ```
   产物是 `dist/gui-experimental.cjs`，已提交。
2. 在 `~/.config/opencode/opencode.jsonc` 的 `"plugins"` 数组末尾加上本仓库路径（已经加了，带注释）：
   ```jsonc
   "/Users/mingpeiwang/Desktop/Code工作区/opencode-session-fork"
   ```
3. 服务端会热加载。可以用 `opencode api plugin.list` 确认 `opencode-session-fork` 是 `active`。桌面窗口要**重启桌面端**才一定能加载到 GUI。
4. 改了代码之后：`npm run build`，再重启桌面端。

## 回滚

- 删掉 `opencode.jsonc` 里那一行（以及上面两行注释），然后重启桌面端。
- 或者整体恢复安装前的备份：`~/.config/opencode/opencode.jsonc.bak-session-fork-20261119`。注意：备份之后如果改过配置，那些改动也会一起丢掉，所以优先用删行的方式。
- 插件不改宿主、不改其他插件、不写原会话，回滚之后不留任何东西。已经建出来的分叉会话是普通会话，留在会话列表里，可以手动删除。

## 怎么用

- 划选任意助手回答（正文或「思考」都可以）里的文字，松开鼠标。Fork 按钮出现在宿主浮条（Copy 等）的末尾；宿主浮条没出现时，会在选区附近单独弹一个小浮条。拖拽过程中不会出现。
- 右侧面板：
  - Enter 发送，Shift+Enter 换行；生成过程中可以点「停止」。
  - 「在标签页打开」会切到宿主的完整界面。
  - 分叉会话需要授权时，面板会提示，并给出「在标签页打开」按钮，到标签页里处理授权。
- 关闭：关掉侧栏标签即可，分叉会话保留在服务端。

## 依赖的宿主内部约定（升级后先查这里）

| 约定 | 位置（2.3.0） | 失效时的表现 |
|---|---|---|
| 助手片段 DOM：`[data-timeline-part-id="<msgID>:text:<n>"]` | `route-*.js` 里的 `ks.contentEntries` | Fork 按钮不出现，宿主正常 |
| 宿主浮条：`[data-component=timeline-quote]` | `route-*.js` 里的 `pk()` | 自动改用自绘浮条 |
| 主题变量 `--v2-*` | 宿主 CSS | 颜色退回到 fallback |

数据层只用官方 client：`message.list`、`session.get/fork/update/interrupt`，以及 `server.data.session.*`；视图层只用 `Panel`、`ctx.ui.*`、`ctx.layout`、`ctx.tabs`。

升级后自检：
1. `opencode api plugin.list` 看插件状态。
2. 划选一段助手回答，看 Fork 按钮会不会出现。
3. 如果不出现，在 DevTools 里查 `document.querySelector('[data-timeline-part-id]')` 的格式是否变了。

## 已知限制

1. **右侧是简化视图**：只显示用户消息、助手正文（用宿主的 Markdown 渲染，支持公式和代码）、可折叠的思考、工具和命令的一行摘要。没有工具卡片、diff、模型或 agent 选择器、附件、斜杠命令。要完整功能，点「在标签页打开」。
2. **授权不在面板里处理**：面板只提示，引导到标签页。permission-notify 的浮窗照常弹出。
3. **草稿不持久化**：草稿只存在窗口内存里。重启桌面端后分叉标签会恢复，但还没发送的草稿会丢。
4. **首条用户消息是用户自己发出的**：所选文字作为草稿放进输入框，不会预先写进历史。原因是服务端的 `resume:false` 会把消息停在 inbox 里，不进历史；导出导入的 experimental 接口为了稳定性也没采用。
5. **分叉的截断点在所选消息之后**：同一轮里后面的工具步骤和后续回答不复制。如果所选消息是会话里最新的一条，而且会话还在生成，会复制当前的半成品。
6. **服务端的 fork-notice**：宿主内置插件会在分叉会话里放一条 `<fork-notice>` synthetic 消息，告诉模型这是分叉，第一次发送时进入历史。面板不显示它。
7. **不做多级分叉**：分叉面板里的选区不会出现 Fork。
8. **验收缺口**：界面层各项还没有真机点验，统一由 ACCEPTANCE.md「第二轮」的点验清单接管。
9. **openclaw-inbox 的标题栏徽标**本来就被它自己的配置关掉了（`header:false`，2026-11-17 起），跟本插件无关。
10. 阶段二为了不触发授权弹窗，没有复核 `app.asar` 哈希和其他插件仓库的 `git status`。人工复核命令：
    ```
    shasum -a 256 /Applications/OpenCode.app/Contents/Resources/app.asar   # 期望 f172c177be6394cf98784d3468298fbb6f1ec2112b8a64167dcd2a9ecb244e1f
    git -C ~/Desktop/Code工作区/openclaw-inbox status --short
    git -C ~/Desktop/Code工作区/permission-notify status --short
    ```

## 仓库结构

```
src/core.ts          纯逻辑（part id 解析、标题、截断点、排序、草稿文本），test/core.test.ts 覆盖
src/gui.tsx          插件主体：选区 → Fork 按钮 → fork 流程 → 侧栏面板
src/style.css        样式（宿主主题变量 + fallback）
scripts/verify-fork.ts  数据层验收脚本（会在服务端建一个分叉会话，用完记得删）
scripts/snapshot.py     只读的会话快照
.research/           解包产物与验收记录（gitignore，不提交）
```
