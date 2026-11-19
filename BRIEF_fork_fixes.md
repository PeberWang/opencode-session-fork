# 任务书：Fork 插件两个体验缺陷

他刚在 OpenCode 2.3.0 上验收了 `opencode-session-fork`，功能通了但面板是空的，还有一处选区时序不对。两个都修。

## 缺陷一，Fork 在鼠标未松开时就出现

现象。划词过程中手指还没抬起，Fork 已经出现；松开后宿主自己的 Copy 浮条才出来，于是 Fork 先在空中独自出现，再和 Copy 并排，看起来像两个东西先后跳出来。

期望。只在选区确定之后、也就是鼠标松开并且宿主浮条出现之后再出现，且与 Copy 同一浮条并排。选区仍在拖拽时，一律不显示。

证据。他口述，无截图。

## 缺陷二，面板空白，根本没法用

现象。点 Fork 后右侧确实开出一个标签，标题是 Fork，但面板里既没有标题行、没有消息、也没有输入框，整块是空的。

证据。

- 分叉会话已正常建立，`ses_e0bc5c9aeffeZOYGQAjvZcCn3j`，标题 `Fork · Continuing from last`，项目目录 `~/Desktop/Code工作区/retiring-officials-innovation`，建立时间 08:33:38。
- 该会话的历史确实拷过去了，`GET /api/session/ses_e0bc5c9aeffeZOYGQAjvZcCn3j/message` 能返回消息。
- 桌面端渲染日志同一秒报错，`~/Library/Application Support/ai.opencode.desktop/logs/20261119T143152/renderer.log` 第 1 行。
  `[2026-11-19 08:33:38.152] [error] [plugin] opencode-session-fork TypeError: Cannot read properties of undefined (reading 'length')`
- 截图在 `~/.openclaw/workspace/media/inbound/openclaw-staged-fc9a7dfc-18fe-4eb2-b311-9728bd3ce351/input-0b38bc9b-6b54-4a50-beb9-3a184597b9bd.jpg`。

判断。面板组件在首次渲染时读到了 `undefined` 的 `.length`，整个 Panel 渲染中断，所以只剩宿主的标签壳。重点查 `ForkView` 里 `messages()`、`data().session.message.list()`、`permissions()` 以及 `props.tab` 的取值时序，还有宿主 2.3.0 与 2.2.7 的类型差异。别只加 `?.` 掩盖，要找到是哪一个数据源在同步完成前就返回了 undefined，并改成有明确初值。

## 顺带核实

- 面板在分叉会话没有消息时要有明确空态文案，不能白屏。
- 面板底部输入框要能输入、能发送、能看到流式回复，发送后按钮有状态变化。
- 「在标签页打开」按钮仍然可用。

## 验收（真机，逐条记录）

1. 按住鼠标拖选文字的全过程中，Fork 不出现。
2. 松开鼠标、宿主浮条出现后，Fork 与 Copy 并列出现。
3. 点 Fork，右侧面板完整出现，有标题行、消息列表、输入框。
4. 面板里消息列表显示复制过来的历史，与标签页里的一致。
5. 在面板输入一句并发送，能看到回复流式输出。
6. 新建一个没有消息的分叉，面板显示空态而不是白屏。
7. 重启桌面端后，上述全部仍然成立。
8. `renderer.log` 里不再出现 `opencode-session-fork` 的 error。
9. 构建与类型检查通过，贴输出。

## 边界

- 只改本仓库。不碰宿主应用包、不碰其他插件。
- 不改动已有功能，只修这两处与它们直接相关的代码。
- 可以本地提交，不推送，版本号不动。
- 需要重启桌面端才生效的，在交付里写明，别让他自己猜。

## 交付

更新 `ACCEPTANCE.md` 记录上面九条的实测结果与证据，`HANDOFF.md` 补一句这次改了什么。
