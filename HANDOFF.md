# HANDOFF — opencode-session-fork（给 OpenClaw）

OpenCode Desktop 的 GUI 插件。在助手消息里划选一段文字，点「Fork」，就会新建一个分叉会话：

- 历史到这条消息为止。
- 标题是 `Fork · <原标题前 20 字>`。
- 分叉会话开在原会话**右侧的侧栏**里。所选文字以引用卡片的形式出现在输入框上方，输入框是空的，不会自动发送。

设计与证据见 `DESIGN_FORK.md`，验收见 `ACCEPTANCE.md`。

## 最近一次改动（2026-11-24 第六轮，`BRIEF_WRITEBACK_MODEL_FIX.md`）

写回摘要在真机上失败过一次：`writeback skipped (...): summary failed: Model not found: deepseek/deepseek-flash`。typecheck、test（33/33）、build 都通过，`dist/gui-experimental.cjs` 是这次的构建产物。真机点验待做，见文末。

### 诊断结论：不是 variant，是请求落在别的 location

服务端日志（`~/.local/share/opencode/log/opencode.log`，22:52Z = 本地 16:52）里那一次调用是这样的：

```
22:52:20.604  读取 ~/.config/opencode/opencode.jsonc
22:52:20.615  location services booted directory=/Users/mingpeiwang/.config/opencode
22:52:20.617  POST /api/experimental/generate/text → 404
22:52:20.717  provider.updated / model.updated（同一个 .config/opencode location 才加载完）
```

`Generate.text` 的实现（2.2.7 二进制里的 `Generate.text`）先 `ModelResolver.resolve(model)`，拿不到就查该 location 的可用模型列表，再报 `Model not found: <provider>/<id>`，HTTP 404。这次请求被当成 `~/.config/opencode` 这个 location 的请求，新 location 刚启动、provider 还没加载完，所以解析不到 `deepseek-flash`。也就是说：**插件调用的 client 没把 Fork 所在目录带上去，服务端在一个临时启动的 location 里解析模型**，和 variant、凭据都无关。

### 三种写法的实测

对正在运行的桌面端，用 `opencode api` 带上 Fork 项目的目录头发请求，三种写法都返回 `{"data":{"text":"ok"}}`：

- `{"providerID":"deepseek","id":"deepseek-flash","variant":"none"}`
- `{"providerID":"deepseek","id":"deepseek-flash"}`
- `{"providerID":"deepseek","id":"deepseek-v4-pro"}`

所以 `#none` 在这条路径上是可用的，默认值保留 `deepseek/deepseek-flash#none`（关闭思考，摘要约 2 秒；开着思考曾超过 20 秒）。

### 改了什么

- **把目录钉在请求上**（`src/gui.tsx`）：`experimental.generate.text` 的第二个参数带上 `headers: { "x-opencode-directory": encodeURIComponent(directory) }`，`directory` 取 `session.directory`，退回 `session.location?.directory`。服务端按这个 location 解析模型，不再临时启动别的 location，也避开了 location 冷启动的竞态。
- **variant 降级重试一次**（`src/writeback.ts`）：`modelAttempts()` 给出「原样」和「去掉 variant」两个候选；只有报错像模型引用问题（`Model not found` / `Model unavailable` / `Variant unavailable` / `model.variant`）才丢掉 variant 重试，其它错误（断网、超时）不重试。重试成功不额外记日志。整个循环仍受一次 `timeoutMs` 约束。
- **失败诊断日志**（`src/gui.tsx` 的 generate 接线处，每个失败的尝试一行，成功不记）：

```
[session-fork] generate failed: model={"providerID":"deepseek","id":"deepseek-flash","variant":"none"} dir=/Users/.../retiring-officials-innovation ref=deepseek/deepseek-flash#none: Model not found: deepseek/deepseek-flash
```

  之后仍然是原来那一行 `writeback skipped (...)`，两行都在 `renderer.log`。
- 测试：新增「模型被拒 → 去掉 variant 重试一次并成功」「两次都拒 → 一行日志、结束」「非模型引用错误不重试」等断言，共 33 项。

### 真机点验（待做）

1. 在任意项目里开一个 Fork，让它改一个文件（比如改一行注释），等回复结束。
2. 关闭 Fork 标签：应弹出「并入主线？」确认框，确认后主会话出现写回 notice。
3. 若仍失败，把 `renderer.log` 里新的 `[session-fork] generate failed: ...` 整行发回来——它会同时给出 model 对象、目录和 ref。

## 最近一次改动（2026-11-23 第五轮，`BRIEF_FORK_WRITEBACK.md`）

关闭 Fork 时的受控写回：Fork 期间原会话不动，关闭标签后按用户同意把这段分叉的结论写回原会话一条摘要。typecheck、test（32/32）、build 都通过，`dist/gui-experimental.cjs` 是这次的构建产物。**真机未点验**，清单见 `ACCEPTANCE.md`「第五轮真机验收（写回）」。

- **写回什么**：一条 synthetic 消息，头部「来自 Fork · <分叉名>」（分叉名取标题去掉 `Fork · ` 前缀后的部分，不重复出现「Fork」），三段——结论（两三句）、改动（文件路径各一句，最多 10 个，超出写「另有 N 个文件」）、还悬着（最多三条），三段合计不超过 300 字。写入走官方 `session.synthetic({ resume: false })`，和宿主自己的后台通知同一条路：不开始一轮、不触发原会话的模型，原会话下一条消息发出时模型才会读到。
- **呈现**：宿主把 synthetic 消息画成一行灰色 notice（正文是 description）。插件的装饰器把这一行改成可点击：点开显示三段详情，附「回到 Fork」按钮（重开侧栏标签）。宿主改了这条 DOM 约定则降级为纯文本行，写入不受影响。
- **摘要**：用 `experimental.generate.text` 走 OpenCode 现有凭据，默认 `deepseek/deepseek-flash#none`（关闭思考；开着思考一次长分叉摘要要 20 秒以上，关掉约 2 秒），5 秒超时，超时、断网、模型不可用一律静默跳过并记一行日志，绝不阻塞关闭（关闭钩子同步返回，写回在后台跑）。
- **幂等与确认**：默认开启、每次关闭先弹「并入主线？」（可选否）；同一个 Fork 只写回一次（状态记在分叉会话 metadata 的 `sessionFork.written`，重启后也有效；主会话里已写回的标记也会被认出来）；选否后要等分叉有新消息才会再问；只问问题、没改动没结论的分叉不写回也不弹窗。
- **配置**：插件 options 的 `writeback` 块——`enabled`、`maxChars`、`confirm`、`model`（`provider/model#variant`）、`timeoutMs`，默认值即上面口径，见 README。

## 最近一次改动（2026-11-21 第四轮，`BRIEF_fork_ui4.md`）

typecheck、test（20/20）、build 都通过，`dist/gui-experimental.cjs` 是这次的构建产物。第四轮真机试用已确认生效；后来又实测到 `vite build` 之后界面自动加载新 bundle，**不需要重启桌面端**（见 `ACCEPTANCE.md`「第四轮真机验收」）。

### 执行链按宿主原版重画（`src/timeline.tsx`）

**先查复用入口，结论是没有**：`@opencode/plugin@2.3.0/dist/gui` 的 `ctx.ui` 只公开 Icon、Button、Markdown、Code 这类基础组件，注册表里也没有工具 part 的渲染器。宿主时间线的工具渲染（`session-ui/src/timeline-next/*`、`tools/tool-renderer.tsx`、`components/basic-tool.tsx`）只在宿主内部使用。所以这里自绘，形态和数值从宿主源码与 `main-*.css` 里照搬。抽出的对照源码在 `.research/src-extract/ui4/`。

对照的是宿主的「compact」预设（时间线详细程度设置里各项都是 grouped/collapsed 的那一档），因为任务书要求默认全部折叠：
- **两层折叠**。一轮回答里，两段正文之间连续的工具调用和思考折成一行，用它干的事命名，例如 `Explored 3 files, 1 search · 2 commands`、`Edited core.ts · 1 command`、`Ran 2 commands`。命名优先级和宿主一样：改文件 > 跑命令 > 其他工具 > 浏览。展开后每个调用各占一行，每行还能再展开。只有思考的一段显示成独立的 `Thought 3s` 行。同一轮里的多条助手消息（多个 step）按一条流处理，所以一段调用可以跨 step 折在一起，这一点也和宿主相同。
- **每个调用一行**：标题、灰色副标题、`key=value` 参数，取法和宿主的 BasicTool 一致。Shell 显示命令（等宽字体），Read 显示文件名和 offset/limit，Grep/Glob 显示相对项目根的目录和 pattern，Edit/Write 显示文件名，有 diff 时右侧标 `+N −M`。宿主不认识的工具（MCP 等）显示 ``Called `name` ``，副标题按宿主的顺序取 description/query/url/path/pattern/name，再加最多 3 个参数。
- **三种状态**：
  - 运行中：标题上有一道扫光（对应宿主的 TextShimmer）。分组行本身不扫光，因为宿主的分组行只记录结果。
  - 完成：正常显示。
  - 失败分两种。调用报错时，标题变灰，末尾加红色「失败」，展开后第一行是红色的错误信息。命令以非零码退出或超时的，状态仍是 completed，末尾显示红色的「退出码 N」或「已超时」，和宿主一样。
  - 用户主动停止的调用（abort/interrupt、`Command cancelled`、shell 被 kill）按宿主的规则不算失败，shell 显示灰色的「已停止」。
  - 退出码只认数字。服务端以字符串报回的 `NaN`、`Infinity` 不算失败。
- **「思考中」只给正在写的那一段**：和宿主一样，只有生成中那一轮最后一条消息的最后一个 part 算正在写。中途被停止、或者分叉时被截断的思考，显示为已完成的 `Thought`，不会一直闪。其中文本为空的直接不显示。
- **用户自己跑的命令**（shell 消息）不折叠，和宿主的 ShellCard 一致：直接显示命令和输出。输出被截断时保留最后几行，顶部渐隐。没有成功时，下方显示退出码、「已超时」或「已停止」。
- **展开后的内容**：
  - Shell：命令和输出放在宿主那种带细边的控制台框里。
  - Edit/Write/Patch：显示 diff。来源是调用 metadata 里的 unified diff（去掉文件头，用 `ctx.ui.Code` 按 `diff` 高亮）；还没有 metadata 时，用 oldString/newString 拼一个删加对照。Write 按扩展名高亮文件内容。
  - 其他工具：「输入」显示格式化的 JSON 入参，「输出」显示文本输出。
  - 输出、diff、文件内容、入参 JSON 超过宿主控制台的 240px 高度时都会截断，底部渐隐，下面有「显示更多 / 收起」。大文件的 Write 不会在侧栏里一次铺开几千行。
- **视觉**：行高 28px，13px 字号，标题字重 530，分组内的行和副标题用 440。箭头用宿主的 `fill-triangle-down`，收起时朝右；鼠标悬停或展开时才显示，旋转动画 0.15s。展开内容左侧有一条半透明竖线，内容缩进 14px，Shell 不画这条线。颜色全部用宿主的 `--v2-*` 变量，带 fallback。宿主的时间线行没有逐个工具的图标，这里也不加，以宿主为准。
- **展开和收起**：用高度过渡（grid 0fr→1fr，0.2s），对应宿主的 slideDown/slideUp，不是跳变。系统开了「减少动态效果」时关掉动画和扫光。内容在第一次展开时才挂载，之后一直保留。
- **折叠状态**：每一行的开合状态按 key 存在面板自己的 store 里。key 的取法和宿主一样：工具调用用调用 id，正文和思考用「消息 id + 类型 + 同类序号」，一整段的 key 取它的第一个 part。这样服务端重读消息之后（例如一轮结束时的 reconcile），key 也不会错位。历史流式增长、新行加入时，已经展开的行保持展开，因为行用字符串 key 渲染，不会重挂载。关掉面板再打开，或者重启，所有行回到折叠。
- 数据来源没有变，仍然是第三轮那个私有 Data 实例，没有新增服务端调用。

### 输入框压到一行

- 默认一行：20px 行高加上下各 5px，共 30px。外框是 0.5px 细边加浅底色，聚焦时边框加深一档，没有阴影和聚焦光圈。
- 随内容向上增高，最多 6 行（130px），再多就在框内滚动。
- 去掉了占位文字和「发送/停止」文字按钮，换成框内右侧的小图标按钮：空闲时是 ↑（没有内容时禁用），生成中是 ■（停止）。原来的用法说明放进了 `aria-label`。
- Enter 发送、Shift+Enter 换行、输入法组字时 Enter 不发送，这些行为没有变。

### 选区改为输入框上方的引用卡片

- Fork 之后输入框是空的，所选文字作为引用卡片显示在输入框正上方。卡片左侧有竖线，浅底，12px 字，最多显示 3 行，超出部分省略。点击卡片展开全文，展开后最高 216px，可以滚动；再点收起。在卡片里拖选文字不会触发展开。
- 右侧的 × 移除引用，焦点回到输入框。移除后输入框仍是单行，面板不会塌。
- 只有引用、不写正文也可以发送。
- 请求发出到返回之间，用户又输入的文字会保留，作为下一条消息，不会被清空。发送失败时提示「发送失败」，草稿保持原样。
- 输入框变高，或者引用卡片出现、消失时，如果原本停在列表底部，就继续停在底部。面板宽度变化时，会重新计算输入框的高度。
- 已发送的用户消息也读 metadata：引用卡片在上，正文在下，和宿主时间线的显示一致。
- **草稿分两段存**：`ctx.storage.memory("drafts")` 里分 `text` 和 `quote` 两部分，关掉面板再打开，正文和引用都能恢复。旧版本留在窗口内存里的草稿没有 `quote` 字段，照常读，只是不会出现引用卡片。发送成功后两段都清空；发送失败则都保留。关闭标签时两段一起删除。

### 引用怎么进消息（先定方案，再实现）

`session.prompt` 的入参（`SessionPromptInput`）没有结构化引用字段，只有 `text`、`files`、`agents`、`skills`、`metadata`。宿主 composer 发送时间线 quote 的做法（`app/src/composer/request.ts` + `comment-note.ts`）是两份同时写：
- **`text`（模型读到的）**：用户正文，后面接一个换行，再接 `formatQuoteComment` 的输出：`The user quoted the following from earlier in the conversation:`，然后每行引用前缀 `> `。前缀的作用是防止引用里的文字提前结束引用、被模型当成用户自己的话。
- **`metadata`（界面读到的）**：`{ displayText: 正文, comments: [{ type: "quote", text }], attachments: [] }`。宿主时间线靠它把用户消息还原成「正文 + 引用卡片」。

已核对宿主 `app/src/composer/schema.ts` 里的 `QuoteComment`：字段只有 `type: "quote"`、`text`，以及可选的 `comment`、`source`。`commentID` 只出现在 composer 内部的 `QuoteContextItem` 里，不会写进消息的 metadata。所以 `{ type: "quote", text }` 能被宿主解码。

**采用：和宿主完全相同的这两份**。引用不带 `source`，所以措辞是宿主给时间线引用用的 "earlier in the conversation"，这和分叉的实际情况一致：所选文字就在分叉的历史里。效果是在标签页打开分叉时，宿主会把这条消息显示成正文加引用卡片；面板里的用户消息也读同一份 metadata，显示方式一致。

## 第四轮点验步骤（已完成，留作回归清单）

**准备**：
1. 确认 `npm run build` 已跑过（这一轮已跑）。
2. ⌘Q 完全退出桌面端，再打开。
3. 找一个会话，里面要有一条**带工具调用**（读文件、跑命令，最好还有一次改文件）的助手回答。
4. 记下 `~/Library/Application Support/ai.opencode.desktop/logs/` 下最新的时间目录，最后一步要查它的 `renderer.log`。

每一条都写了「做什么、看什么、怎样算通过」。截图可以存进 `.research/verify/`。

| # | 做什么 | 看什么 | 算通过 |
|---|---|---|---|
| 1 | 在这条助手回答的**正文**里拖选一段文字，松开鼠标，点浮条末尾的「Fork」 | 右侧侧栏出现 Fork 标签。历史里这一轮的工具部分是什么样子 | 工具部分是若干行很矮的灰色摘要，例如 `Explored 2 files · 1 command`、`Ran 1 command`，每行都没有展开。它的说法和用词，与同一条消息在左侧宿主时间线里折叠时的那一行一致或接近（宿主时间线设置不是 compact 时，宿主可能本来就是展开的；这种情况下比较的是宿主折叠后的样子）。没有出现原来那种 `工具: read · completed` 的文字 |
| 2 | 鼠标移到某一行摘要上，再点它 | 行尾的小三角；点之后的展开过程 | 悬停时出现朝右的小三角。点击后三角转为朝下，内容有一个短暂的向下滑开的过渡，不是突然出现。展开后是一个个单独的调用行（`Read a.ts`、`Shell npm test` 等），左侧有一条细竖线 |
| 3 | 在第 2 步展开的列表里，分别点开一个 Shell 行、一个 Read 或 Grep 行、一个 Edit 行（有的话） | 每种调用展开后的内容 | Shell：带细边的框，上面是完整命令，下面是输出。Read/Grep：「输入」显示完整的 JSON 参数，「输出」显示结果文本。Edit：显示带 `+`/`-` 的着色 diff，行尾有绿色 `+N` 和红色 `−M`。输出很长时，框截断在大约 240px，底部渐隐，下面有「显示更多」，点了显示全部、出现「收起」。报错的调用末尾有红色「失败」，展开后第一行是红色的错误信息；命令非零退出时末尾是红色「退出码 N」，被停止时是灰色「已停止」 |
| 4 | 把第 2、3 步展开的行收起一部分、保留一部分，然后在面板里发一条消息（见第 7 步），等回复进来 | 已展开或已收起的行在新消息进来后的状态 | 展开的仍然展开，收起的仍然收起。新出现的工具行默认折叠 |
| 5 | 看面板底部的输入框，不输入任何内容 | 高度、边框、按钮 | 只有一行高（约 30px，比宿主主输入框矮），细边浅底，没有占位文字，右侧一个小的 ↑ 图标。有引用卡片时 ↑ 可以点；先点 × 移除引用，↑ 就变成灰色、不能点 |
| 6 | 在输入框里按 Shift+Enter，连续换 8 行，每行打几个字 | 高度变化 | 每多一行，输入框向上长高一行。长到 6 行后不再变高，框内出现滚动，能滚到第 7、8 行 |
| 7 | 回到刚 Fork 出来的状态（关掉标签重新 Fork 也可以） | 输入框和它上方 | 输入框是空的。所选文字显示在输入框正上方的引用卡片里：左侧竖线，浅底，字比正文小，最多 3 行，后面跟省略号 |
| 8 | 点引用卡片的正文；再点一次；然后点卡片右侧的 × | 卡片的变化，以及输入框 | 第一次点显示全文，太长时卡片内可以滚动。第二次点收回 3 行。点 × 后卡片消失，光标落回输入框。输入框仍是一行高，面板高度和布局不跳动、不塌 |
| 9 | 重新 Fork 一次，保留引用，输入「这段是什么意思」，按 Enter | 面板里新出现的用户消息，以及随后的回复 | 用户消息上方是引用卡片，下方是「这段是什么意思」，看不到 `The user quoted the following…` 这段原文。助手回复逐字流式出现，不是最后一次性出现。回复的内容明显是针对所引用那段话的。再点「在标签页打开」，宿主标签页里同一条用户消息也显示为正文加引用卡片 |
| 10 | 在输入框里按 Shift+Enter，再按 Enter；生成过程中点输入框右侧的 ■ | 换行、发送、停止 | Shift+Enter 只换行，不发送。Enter 发送，发送后输入框清空并回到一行高。生成中 ↑ 变成 ■，点 ■ 后生成停止，「生成中…」消失，按钮变回 ↑。用中文输入法组字时按 Enter 只是上屏，不会发出去 |
| 11 | 点侧栏 Fork 标签上的叉关掉它；再 Fork 一次，再关掉 | 标签和左侧主界面 | 标签正常关闭，主界面不卡、不报错，可以再次 Fork |
| 12 | 保留一个 Fork 标签，⌘Q 退出桌面端再打开，点开这个标签 | 面板内容 | 面板能打开，标题正确，历史完整，工具链按第 1 步的样子全部折叠。没发送的草稿和引用此时没有了，这是已知限制第 6 条，不算失败 |
| 13 | 终端里执行 `grep -n "opencode-session-fork" ~/Library/Application\ Support/ai.opencode.desktop/logs/<目录>/renderer.log`，对准备第 4 步记下的目录和第 12 步重启后新出现的目录各执行一次 | 输出 | 两次都没有 `[error]` 行 |

有任何一条没通过，把条目编号、截图和那份 `renderer.log` 交给接手的人就能定位。

## 第三轮改动（2026-11-19，`BRIEF_fork_fixes3.md`）

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
- 插件不改宿主、不改其他插件；写回只在关闭 Fork 且用户确认时，才向原会话追加一条摘要（synthetic 消息，不触发模型）。已写回的消息留在原会话里，是普通消息，可以手动删除；已建的分叉会话也一样留在会话列表里，可以手动删除。其余不留任何东西。

## 怎么用

- 划选任意助手回答（正文或「思考」都可以）里的文字，松开鼠标。Fork 按钮出现在宿主浮条（Copy 等）的末尾；宿主浮条没出现时，会在选区附近单独弹一个小浮条。拖拽过程中不会出现。
- 右侧面板：
  - 历史里的工具调用默认折叠成一行一行的摘要，点哪一行展开哪一行，展开后还能逐个调用再展开。
  - 输入框上方是 Fork 时选中的引用，点击展开全文，点 × 移除。
  - Enter 发送，Shift+Enter 换行；输入框右侧的 ↑ 是发送，生成过程中变成 ■（停止）。
  - 「在标签页打开」会切到宿主的完整界面。
  - 分叉会话需要授权时，面板会提示，并给出「在标签页打开」按钮，到标签页里处理授权。
- 关闭：关掉侧栏标签即可，分叉会话保留在服务端。若这个分叉定下了结论或改过文件，会先弹「并入主线？」确认——同意后原会话里多一条可展开的「来自 Fork · …」摘要（不会触发模型）；选「不并入」或没有内容可写，则什么都不写。

## 依赖的宿主内部约定（升级后先查这里）

| 约定 | 位置（2.3.0） | 失效时的表现 |
|---|---|---|
| 助手片段 DOM：`[data-timeline-part-id="<msgID>:text:<n>"]` | `route-*.js` 里的 `ks.contentEntries` | Fork 按钮不出现，宿主正常 |
| 宿主浮条：`[data-component=timeline-quote]` | `route-*.js` 里的 `pk()` | 自动改用自绘浮条 |
| 主题变量 `--v2-*` | 宿主 CSS | 颜色退回到 fallback |
| 时间线 notice 行：`[data-slot=session-timeline-notice]`，标题在行内第一个 `<bdi>` | `session-ui` 时间线 `row.tsx` | 写回消息仍写入、仍送达模型，显示退化为纯文本一行 |

数据层只用官方 client：`message.list`、`session.get/fork/update/interrupt/synthetic`、`session.inbox.list`、`experimental.generate.text`，以及 `server.data.session.*`；视图层只用 `Panel`、`ctx.ui.*`、`ctx.dialogs`、`ctx.layout`、`ctx.tabs`。

升级后自检：
1. `opencode api plugin.list` 看插件状态。
2. 划选一段助手回答，看 Fork 按钮会不会出现。
3. 如果不出现，在 DevTools 里查 `document.querySelector('[data-timeline-part-id]')` 的格式是否变了。

## 已知限制

1. **第四轮真机结论**：执行链、输入框、引用卡片、发送格式这四块已由 2026-11-21 的真机试用确认（见 `ACCEPTANCE.md`「第四轮真机验收」），并实测到热插：`npm run build` 之后不用重启桌面端，界面即加载新 bundle。下面的「第四轮点验步骤」留作升级后的回归清单。
2. **执行链是对照宿主源码自绘的，没有复用宿主组件**：宿主没有公开工具渲染器。数值和文案取自 2.3.0 的源码与 CSS，而本机桌面端现在跑的 CLI 已经是 2.3.2（`opencode-cli` 路径里的版本号）。宿主之后改了样式，这里不会跟着变。和宿主相比还有几处简化：
   - 展开一段之后，连续的 Read 不会再合并成「Read a, b, c」一行，连续的文件改动也不会合并成一张文件卡片，每个调用各占一行。
   - diff 用 `ctx.ui.Code` 的 `diff` 高亮显示，不是宿主那种左右分栏、带行号的 diff 查看器。
   - 不显示 LSP diagnostics。
   - 子代理（subagent）也折进分组，不单独显示成「Started 1 subagent」那样的事件行。
   - 后台 shell 的输出不会实时跟随刷新。
3. **只有 compact 一种形态**：不读宿主的时间线详细程度设置。用户在宿主里选了「Everything」或「Detailed」，面板仍然全部折叠。这是任务书的要求。
   - **工具图标**：宿主的时间线行不画单个工具的图标。BasicTool 虽然接收 `icon` 参数，但 trigger 里并不渲染它（`components/basic-tool.tsx`）。面板以宿主为准，也不画。所以任务书里「工具名与图标」中的图标一项，是有意不做的。
   - **中文文案**：中文界面下，分组行和命令结局（例如「浏览了 3 个文件」「退出码 1」）用的是本插件自己的中文。宿主 2.3.0 没有这些词条的中文，退回英文 `.other` 时会显示成 `1 files`。其余词条用的是宿主自带的中文。
4. **流式时整段历史会重新拆分**：每来一个 token，「消息 → 行」的拆分都会重算一遍。行不会重挂载，展开状态和已渲染的 Markdown 都保留，但开销随历史长度线性增长。宿主为此做了按 part 缓存。分叉的历史一般不长，这一版先不做。如果长分叉在流式时明显卡顿，从这里入手。
5. **授权不在面板里处理**：面板只提示，引导到标签页。permission-notify 的浮窗照常弹出。
6. **草稿只在窗口内存里**：草稿存在 `ctx.storage.memory`，能扛过插件重载，扛不过重启桌面端。重启后分叉标签会恢复，但还没发送的正文和引用都会丢。
7. **引用是一次性的**：每个分叉只带 Fork 时选中的那一段，没有「在面板里再加一段引用」的入口。引用卡片没有宿主 composer 那种「给引用加评论」的编辑器。
8. **分叉的截断点在所选消息之后**：同一轮里后面的工具步骤和后续回答不复制。如果所选消息是会话里最新的一条，而且会话还在生成，会复制当前的半成品。
9. **服务端的 fork-notice**：宿主内置插件会在分叉会话里放一条 `<fork-notice>` synthetic 消息，告诉模型这是分叉，第一次发送时进入历史。面板不显示它，它也不会把一轮回答断开：只有用户消息和用户命令会断开一轮。
10. **不做多级分叉**：分叉面板里的选区不会出现 Fork。
11. **没有窄屏视图**：`Panel` 没有声明 `mobile`，窄屏（手机布局）下宿主不提供这个面板。Fork 打开标签用的是 `tab: "select"`，它在窄屏下会停留在当前视图，所以在很窄的窗口里点 Fork 看起来像没有反应。分叉其实已经建好，在会话列表里能找到。补一个 mobile 视图算新功能，本轮没做。侧栏变窄时（不到 360px），CSS 容器查询会收紧内边距，各行靠省略号截断，不会挤成一条竖线。面板默认宽度仍沿用第一轮的 `Panel.width`（窗口的 45%，最少 360px），用户拖动的宽度由宿主记住。CSS 里没有写死任何宽度。
12. **真机点验的进度**：2026-11-21 第四轮真机试用（`ACCEPTANCE.md`「第四轮真机验收」）已确认执行链、单行输入框、引用卡片三处生效，并实测了热插。第一、二轮验收清单里剩下没逐条点过的，以及第五轮的写回，等下次加载新 bundle 后一起过一遍。
13. **第五轮（写回）尚未真机点验**：关闭路径、确认弹窗、notice 展开与「回到 Fork」目前只有类型检查、32 个单元测试和构建作为依据。下次加载新 bundle 后（点一次 **Settings > Extensions > Plugins** 的 Reload 即可，不必退出）按 `ACCEPTANCE.md`「第五轮真机验收（写回）」逐条过。
14. **openclaw-inbox 的标题栏徽标**本来就被它自己的配置关掉了（`header:false`，2026-11-17 起），跟本插件无关。
15. 阶段二为了不触发授权弹窗，没有复核 `app.asar` 哈希和其他插件仓库的 `git status`。人工复核命令：
    ```
    shasum -a 256 /Applications/OpenCode.app/Contents/Resources/app.asar   # 期望 f172c177be6394cf98784d3468298fbb6f1ec2112b8a64167dcd2a9ecb244e1f（若桌面端已自动升级，哈希会变，属正常）
    git -C ~/Desktop/Code工作区/openclaw-inbox status --short
    git -C ~/Desktop/Code工作区/permission-notify status --short
    ```
16. **写回依赖宿主的 notice 行约定**：三段详情和「回到 Fork」挂在宿主时间线的 `[data-slot=session-timeline-notice]` 行上，靠行内第一个 `<bdi>` 的文字与写回消息的 description 配对。宿主改了这条 DOM 约定后，写回消息本身仍然写入、仍然会被原会话的模型读到，只是显示退化为宿主那行纯文本（没有详情展开、没有「回到 Fork」按钮）。写入只走官方 `session.synthetic`，不受这条约定影响。
17. **摘要模型不可用、超时或断网时静默跳过**：写回在标签关闭之后后台运行，任何失败都不弹窗、不阻塞任何动作（关闭动作本身不等摘要），只在 `renderer.log` 里留一行 `[session-fork] writeback skipped (<forkID>): <原因>`。
18. **只问问题、没有改动也没有结论的 Fork 不写回**：分叉里没有自己的助手回答时，连模型都不问；有回答但没改文件、结论为空时也跳过。两种情况都不弹确认框。
19. **同一 Fork 只写回一次**：写回状态记在分叉会话 metadata 的 `sessionFork.written`（哈希），重启后依然有效；写回后主会话里的标记也会被认出来，防止 metadata 更新失败时重复写。确认弹窗里选「不并入」，会记录当时的状态，要等分叉出现新消息才会再问。
20. **写回只在关闭分叉标签时触发**：钩子挂在 `Panel.close` 上。直接退出桌面端（⌘Q）或只是收起侧栏区域、标签还开着时，不会写回；标签下次会恢复，那时再关才问。这样写回不会和退出流程抢时间，行为也确定。

## 仓库结构

```
src/core.ts          纯逻辑，test/core.test.ts 覆盖：part id 解析、标题、截断点、排序、草稿文本；
                     引用的发送格式（composePrompt/readPresentation）；工具调用的命名与摘要（toolSummary）、
                     分组命名（activityLabel）、一轮回答的折叠（foldTurn）、part 的稳定 key（partKeys）、
                     失败与命令结局判定（toolFailed/shellOutcome）、diff 文本处理（changedFiles/diffBody/stringDiff，
                     写回的文件清单也读这里）
src/writeback.ts     写回判定与摘要的纯逻辑，test/writeback.test.ts 覆盖（依赖注入，不碰宿主）：配置解析
                     （writebackConfig）；分叉自身消息与改动文件提取（ownMessages/changedPaths/transcriptText）；
                     摘要 prompt、JSON 解析与三段格式化、300 字等比例压缩（summaryPrompt/parseSummary/
                     formatSummary/fitSummary）；写回标记、内容哈希与幂等状态（writebackMeta/contentHash/
                     writebackState）；整条流程（runWriteback：无内容跳过、超时与断网静默跳过并记日志、
                     确认与拒绝、写入与去重）
src/timeline.tsx     分叉历史的视图层，按宿主 timeline-next 的 compact 形态自绘：分组行、单个调用行、思考行、
                     用户命令卡片、命令结局标签、控制台输出框、长输出与代码截断、展开收起；
                     开合状态由调用方传入（Disclosures）
src/gui.tsx          插件主体：选区 → Fork 按钮 → fork 流程 → 侧栏面板（私有 Data、消息到行的拆分、
                     开合状态 store、单行输入框、引用卡片、草稿两段存储）；关闭钩子触发后台写回
                     （writeBack，不等摘要、失败只记日志）；写回的三段详情与「回到 Fork」挂在宿主
                     notice 行上（装饰器 + WritebackCard）；「并入主线？」确认弹窗走 ctx.dialogs
src/style.css        样式（宿主主题变量 + fallback；时间线行的数值注明取自宿主 main-*.css；写回行与详情块）
scripts/verify-fork.ts  数据层验收脚本（会在服务端建一个分叉会话，用完记得删）
scripts/snapshot.py     只读的会话快照
test/writeback.test.ts  写回流程的单元测试：配置、消息与文件提取、摘要解析与压缩、标记与哈希，
                        以及 runWriteback 全流程（写入一次、拒绝、只问问题不写、超时/断网/写失败静默跳过）
.research/           解包产物与验收记录（gitignore，不提交）
```
