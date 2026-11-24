// The fork's history, drawn as the host's timeline draws it (session-ui/src/timeline-next with the "compact" preset):
// every stretch of calls folds into one row named by what it did, each call inside is a row of its own, and nothing
// opens until it is clicked. The host exposes none of these renderers to plugins, so they are redrawn here with the
// host's measures and theme tokens; see the CSS for the values and where they come from.
import type { Context } from "@opencode/plugin/gui"
import { For, Index, Match, Show, Switch, createMemo, createSignal, onCleanup, onMount, type JSX } from "solid-js"
import {
  activityLabel,
  basename,
  changedFiles,
  diffBody,
  shellOutcome,
  stringDiff,
  toolFailed,
  toolInput,
  toolName,
  toolOutput,
  toolPending,
  toolSummary,
  type Label,
  type Phrase,
  type ThoughtPart,
  type ToolCall,
  type TurnPart,
  type TurnRow,
} from "./core.ts"

/** Which rows are open, by key. Lives as long as the panel, so rows keep their state while history re-renders. */
export type Disclosures = { open(key: string): boolean; set(key: string, open: boolean): void }

export function createTimeline(ctx: Context) {
  const label = (value: Label) => ctx.t(value.key, value.params)
  const phrase = (value: Phrase) =>
    typeof value === "string" ? value : "plural" in value ? ctx.plural(value.plural, value.count) : ctx.t(value.key)

  /** A row that opens: its one-line trigger, and content mounted the first time it opens, then kept. */
  function Disclosure(props: {
    open: boolean
    onOpenChange: (open: boolean) => void
    trigger: JSX.Element
    /** False when there is nothing to open: no arrow, and the row does not toggle or take focus. */
    content?: boolean
    /** Content under a thin rail, indented; false for a command, whose output box is its own frame. */
    rail?: boolean
    class?: string
    children?: JSX.Element
  }) {
    // A component body is untracked: this reads the state the row mounts with.
    const [mounted, setMounted] = createSignal(props.open)
    const toggle = () => {
      if (props.content === false) return
      if (!props.open) setMounted(true)
      props.onOpenChange(!props.open)
    }
    return (
      <div
        class={`session-fork-tool${props.class ? ` ${props.class}` : ""}`}
        data-open={props.open ? "" : undefined}
        data-rail={props.rail === false ? "false" : undefined}
      >
        <button
          type="button"
          class="session-fork-tool-trigger"
          aria-expanded={props.content === false ? undefined : props.open}
          tabIndex={props.content === false ? -1 : undefined}
          data-static={props.content === false ? "" : undefined}
          onClick={toggle}
        >
          <span class="session-fork-tool-info">{props.trigger}</span>
          <Show when={props.content !== false}>
            <span class="session-fork-tool-arrow" aria-hidden="true">
              <ctx.ui.Icon name="fill-triangle-down" size="small" />
            </span>
          </Show>
        </button>
        <Show when={props.content !== false}>
          {/* The track clips; the inner box keeps its padding and gaps whether open or not, so nothing jumps. */}
          <div class="session-fork-tool-content" inert={!props.open}>
            <div class="session-fork-tool-body">
              <div class="session-fork-tool-inner">
                <Show when={mounted() || props.open}>{props.children}</Show>
              </div>
            </div>
          </div>
        </Show>
      </div>
    )
  }

  /** The title; a running call's shimmers, as the host's TextShimmer does. */
  const Title = (props: { text: string; pending?: boolean; muted?: boolean; shrink?: boolean }) => (
    <span
      class="session-fork-tool-title"
      data-pending={props.pending ? "" : undefined}
      data-muted={props.muted ? "" : undefined}
      data-shrink={props.shrink ? "" : undefined}
    >
      {props.text}
    </span>
  )

  /** How a command ended, where it did not succeed: red for a failure, muted for a stop. */
  const Outcome = (props: { outcome: ReturnType<typeof shellOutcome> }) => (
    <Show when={props.outcome}>
      {(outcome) => (
        <span class="session-fork-tool-outcome" data-tone={outcome().tone}>
          {label(outcome().label)}
        </span>
      )}
    </Show>
  )

  /** A command and its output, as the host's console box shows them; long output is cut, with a toggle for the rest. */
  function Console(props: { command?: string; output?: string; error?: boolean; tail?: boolean }) {
    return (
      <div class="session-fork-console">
        <Show when={props.command}>
          {(command) => (
            <pre class="session-fork-console-command">
              <code>{command()}</code>
            </pre>
          )}
        </Show>
        <Show when={props.output}>
          {(output) => (
            <Clamped tail={props.tail}>
              <pre class="session-fork-console-result" data-error={props.error ? "" : undefined}>
                <code>{output()}</code>
              </pre>
            </Clamped>
          )}
        </Show>
      </div>
    )
  }

  /**
   * Cuts content taller than the host's 240px output box, with "Show more" under it while it is cut. `tail` keeps the
   * last lines in view instead of the first, as the host's card for a command the user ran does.
   */
  function Clamped(props: { tail?: boolean; children: JSX.Element }) {
    const [overflow, setOverflow] = createSignal(false)
    const [expanded, setExpanded] = createSignal(false)
    let frame: HTMLDivElement | undefined
    let inner: HTMLDivElement | undefined
    onMount(() => {
      const measure = () => frame && inner && setOverflow(inner.offsetHeight > frame.clientHeight + 1 || expanded())
      const observer = new ResizeObserver(measure)
      if (inner) observer.observe(inner)
      onCleanup(() => observer.disconnect())
    })
    return (
      <div class="session-fork-clamp" data-expanded={expanded() ? "" : undefined}>
        <div
          class="session-fork-clamp-frame"
          ref={frame}
          data-tail={props.tail ? "" : undefined}
          data-overflow={overflow() && !expanded() ? "" : undefined}
        >
          <div ref={inner}>{props.children}</div>
        </div>
        <Show when={overflow()}>
          <button type="button" class="session-fork-clamp-toggle" onClick={() => setExpanded(!expanded())}>
            {ctx.t(expanded() ? "tool.showLess" : "tool.showMore")}
          </button>
        </Show>
      </div>
    )
  }

  /** A section of an opened call: a caption over its content, as Input and Output. */
  const Section = (props: { caption: string; children: JSX.Element }) => (
    <div class="session-fork-tool-section">
      <div class="session-fork-tool-caption">{props.caption}</div>
      {props.children}
    </div>
  )

  /** Highlighted code, cut as long output is: a large write or diff does not fill the panel with thousands of lines. */
  const Code = (props: { content: string; language?: string }) => (
    <div class="session-fork-codebox">
      <Clamped>
        <ctx.ui.Code content={props.content} language={props.language} class="session-fork-code" />
      </Clamped>
    </div>
  )

  const language = (path: string) => /\.([A-Za-z0-9]+)$/.exec(path)?.[1]?.toLowerCase()

  /** One call: its title line, and what opening it shows, per tool as the host shows it. */
  function ToolRow(props: { tool: ToolCall; disclosure: Disclosures; root?: string }) {
    const key = () => `tool:${props.tool.id}`
    const summary = createMemo(() => toolSummary(props.tool, props.root))
    const name = () => toolName(props.tool)
    const input = createMemo(() => toolInput(props.tool))
    const output = () => toolOutput(props.tool)
    const failed = () => toolFailed(props.tool)
    const errored = () => failed() && props.tool.state.status === "error"
    const outcome = createMemo(() => (name() === "shell" ? shellOutcome(props.tool.state.metadata) : undefined))
    const error = () => props.tool.state.error?.message?.replace(/^Error: /, "")
    const files = createMemo(() => changedFiles(props.tool))
    const changes = createMemo(() =>
      files().reduce((sum, file) => ({ add: sum.add + file.additions, del: sum.del + file.deletions }), { add: 0, del: 0 }),
    )
    const inputJSON = createMemo(() => (Object.keys(input()).length ? JSON.stringify(input(), null, 2) : ""))
    const hasContent = () => name() === "shell" || failed() || !!output() || !!inputJSON() || files().length > 0
    // A memo, so a re-render of the history keeps the rendered diffs instead of drawing them again.
    const diff = createMemo(() => {
      if (files().length) return files()
      const value = input()
      if (name() === "edit" && (typeof value.oldString === "string" || typeof value.newString === "string"))
        return [{ file: String(value.path ?? ""), patch: stringDiff(String(value.oldString ?? ""), String(value.newString ?? "")) }]
      return []
    })

    return (
      <Disclosure
        open={props.disclosure.open(key())}
        onOpenChange={(open) => props.disclosure.set(key(), open)}
        content={hasContent()}
        rail={name() !== "shell"}
        trigger={
          <>
            <Title
              text={label(summary().title)}
              pending={toolPending(props.tool)}
              muted={errored()}
              shrink={summary().title.key === "tool.called"}
            />
            <Show when={summary().subtitle}>
              {(subtitle) => (
                <span class="session-fork-tool-subtitle" data-mono={summary().mono ? "" : undefined} dir="auto">
                  {subtitle()}
                </span>
              )}
            </Show>
            <For each={summary().args}>{(arg) => <span class="session-fork-tool-subtitle">{arg}</span>}</For>
            <Show when={!toolPending(props.tool) && (changes().add > 0 || changes().del > 0)}>
              <span class="session-fork-tool-changes">
                <span data-kind="add">+{changes().add}</span>
                <span data-kind="del">−{changes().del}</span>
              </span>
            </Show>
            <Show when={errored()} fallback={<Outcome outcome={outcome()} />}>
              <span class="session-fork-tool-outcome" data-tone="danger">
                {ctx.t("tool.failed")}
              </span>
            </Show>
          </>
        }
      >
        <Switch
          fallback={
            <>
              <Show when={errored() && error()}>
                {(message) => <div class="session-fork-tool-error">{message()}</div>}
              </Show>
              <Show when={inputJSON()}>
                {(json) => (
                  <Section caption={ctx.t("tool.input")}>
                    <Code content={json()} language="json" />
                  </Section>
                )}
              </Show>
              <Show when={output()}>
                {(value) => (
                  <Section caption={ctx.t("tool.output")}>
                    <Console output={value()} />
                  </Section>
                )}
              </Show>
            </>
          }
        >
          <Match when={name() === "shell"}>
            <Console
              command={typeof input().command === "string" ? (input().command as string) : undefined}
              output={output() || (errored() ? error() : undefined)}
              error={errored() && !output()}
            />
          </Match>
          <Match when={!errored() && diff().length > 0}>
            <For each={diff()}>
              {(file) => (
                <div class="session-fork-tool-file">
                  <Show when={diff().length > 1 || name() === "patch"}>
                    <div class="session-fork-tool-caption">{basename(file.file)}</div>
                  </Show>
                  <Code content={diffBody(file.patch)} language="diff" />
                </div>
              )}
            </For>
          </Match>
          <Match when={!errored() && name() === "write" && typeof input().content === "string"}>
            <Code content={input().content as string} language={language(String(input().path ?? ""))} />
          </Match>
        </Switch>
      </Disclosure>
    )
  }

  const seconds = (time: { created?: number; completed?: number } | undefined) => {
    if (time?.created === undefined || time.completed === undefined) return
    const total = Math.max(0, Math.round((time.completed - time.created) / 1000))
    if (total < 60) return ctx.t("duration.seconds", { count: String(total) })
    return ctx.t("duration.minutesSeconds", { minutes: String(Math.floor(total / 60)), seconds: String(total % 60) })
  }

  /** A thought: "Thought" and how long it took, opening to the thought; "Thinking" while the model writes it. */
  function ThoughtRow(props: { id: string; part: ThoughtPart; live: boolean; disclosure: Disclosures }) {
    const key = () => `thought:${props.id}`
    const duration = () => seconds(props.part.time)
    return (
      <Disclosure
        open={props.disclosure.open(key())}
        onOpenChange={(open) => props.disclosure.set(key(), open)}
        content={!!props.part.text.trim()}
        class="session-fork-thought"
        trigger={
          <>
            <Title text={ctx.t(props.live ? "thinking" : "thought")} pending={props.live} muted />
            <Show when={!props.live && duration()}>
              {(value) => <span class="session-fork-tool-subtitle">{value()}</span>}
            </Show>
          </>
        }
      >
        <ctx.ui.Markdown text={props.part.text} class="session-fork-thought-text" />
      </Disclosure>
    )
  }

  /**
   * A stretch of calls folded into one row, "Explored 3 files · 2 commands", opening to each call. Like the host's, the
   * row only records what happened and does not shimmer; the call running inside it does.
   */
  function GroupRow(props: {
    row: Extract<TurnRow, { kind: "group" }>
    live?: string
    disclosure: Disclosures
    root?: string
  }) {
    const tools = createMemo(() => props.row.parts.flatMap((item) => (item.part.type === "tool" ? [item.part] : [])))
    const activity = createMemo(() => activityLabel(tools()))
    return (
      <Disclosure
        open={props.disclosure.open(props.row.key)}
        onOpenChange={(open) => props.disclosure.set(props.row.key, open)}
        class="session-fork-group"
        trigger={
          <Show when={activity()}>
            {(value) => (
              <>
                <Title text={ctx.t(value().verb)} muted />
                <Show when={value().main.length}>
                  <span class="session-fork-group-detail">{value().main.map(phrase).join(", ")}</span>
                </Show>
                <Show when={value().others.length}>
                  <span class="session-fork-group-separator" aria-hidden="true">
                    ·
                  </span>
                  <span class="session-fork-group-detail">{value().others.map(phrase).join(", ")}</span>
                </Show>
              </>
            )}
          </Show>
        }
      >
        <div class="session-fork-group-list">
          {/* A stretch only grows at its end, so positions keep their part. */}
          <Index each={props.row.parts}>
            {(item) => (
              <Switch>
                <Match when={item().part.type === "tool" && (item().part as ToolCall)}>
                  {(tool) => <ToolRow tool={tool()} disclosure={props.disclosure} root={props.root} />}
                </Match>
                <Match when={item().part.type === "reasoning" && (item().part as ThoughtPart)}>
                  {(part) => (
                    <ThoughtRow
                      id={item().key}
                      part={part()}
                      live={item().key === props.live}
                      disclosure={props.disclosure}
                    />
                  )}
                </Match>
              </Switch>
            )}
          </Index>
        </div>
      </Disclosure>
    )
  }

  /** One row of an assistant turn. `live` is the key of the part the model is writing now, if any. */
  function TurnRowView(props: { row: TurnRow<TurnPart>; live?: string; disclosure: Disclosures; root?: string }) {
    return (
      <Switch>
        <Match when={props.row.kind === "text" && props.row}>
          {(row) => <ctx.ui.Markdown text={row().part.text} />}
        </Match>
        <Match when={props.row.kind === "group" && props.row}>
          {(row) => <GroupRow row={row()} live={props.live} disclosure={props.disclosure} root={props.root} />}
        </Match>
        <Match when={props.row.kind === "thoughts" && props.row}>
          {(row) => (
            <div class="session-fork-thoughts">
              <Index each={row().parts}>
                {(item) => (
                  <ThoughtRow
                    id={item().key}
                    part={item().part}
                    live={item().key === props.live}
                    disclosure={props.disclosure}
                  />
                )}
              </Index>
            </div>
          )}
        </Match>
      </Switch>
    )
  }

  /**
   * A command the user ran, as the host's ShellCard draws it: no row to open, the command and its output in view, the
   * output cut to its last lines until expanded, and how it ended when it did not succeed.
   */
  function ShellCard(props: { command: string; output?: string; status: string; exit: unknown }) {
    const outcome = createMemo(() => shellOutcome({ status: props.status, exit: props.exit }))
    return (
      <div class="session-fork-shell-card">
        <Console command={props.command} output={props.output} tail />
        <Outcome outcome={outcome()} />
      </div>
    )
  }

  return { TurnRowView, ShellCard }
}

/** The host's catalog for the timeline, in English. */
export const timelineMessages = {
  en: {
    "tool.read": "Read",
    "tool.list": "List",
    "tool.glob": "Glob",
    "tool.grep": "Grep",
    "tool.webfetch": "Webfetch",
    "tool.websearch": "Web Search",
    "tool.fetch": "Fetch",
    "tool.searchWeb": "Search web",
    "tool.shell": "Shell",
    "tool.execute": "Execute",
    "tool.edit": "Edit",
    "tool.write": "Write",
    "tool.patch": "Patch",
    "tool.agent": "{{name}}",
    "tool.agent.default": "Agent",
    "tool.skill": "Skill",
    "tool.questions": "Questions",
    "tool.called": "Called `{{tool}}`",
    "tool.failed": "Failed",
    "tool.input": "Input",
    "tool.output": "Output",
    "tool.showMore": "Show more",
    "tool.showLess": "Show less",
    "shell.stopped": "Stopped",
    "shell.timedOut": "Timed out",
    "shell.exit": "Exit {{code}}",
    thought: "Thought",
    thinking: "Thinking",
    "duration.seconds": "{{count}}s",
    "duration.minutesSeconds": "{{minutes}}m {{seconds}}s",
    "activity.explored": "Explored",
    "activity.edited": "Edited",
    "activity.ran": "Ran",
    "activity.used": "Used",
    "activity.files.one": "{{count}} file",
    "activity.files.other": "{{count}} files",
    "activity.reads.one": "{{count}} read",
    "activity.reads.other": "{{count}} reads",
    "activity.editedFiles.one": "{{count}} edited file",
    "activity.editedFiles.other": "{{count}} edited files",
    "activity.searches.one": "{{count}} search",
    "activity.searches.other": "{{count}} searches",
    "activity.webSearches.one": "{{count}} web search",
    "activity.webSearches.other": "{{count}} web searches",
    "activity.pages.one": "{{count}} page",
    "activity.pages.other": "{{count}} pages",
    "activity.skills.one": "{{count}} skill",
    "activity.skills.other": "{{count}} skills",
    "activity.commands.one": "{{count}} command",
    "activity.commands.other": "{{count}} commands",
  },
  // The host's Chinese where it has one. Where it has none (the activity and shell labels), Chinese of our own: Chinese
  // has a single plural form, so English `.other` text would read "1 files".
  zh: {
    "tool.read": "读取",
    "tool.list": "列出文件",
    "tool.websearch": "网页搜索",
    "tool.execute": "执行",
    "tool.edit": "编辑",
    "tool.write": "写入",
    "tool.patch": "补丁",
    "tool.agent.default": "智能体",
    "tool.skill": "技能",
    "tool.questions": "问题",
    "tool.called": "调用了 `{{tool}}`",
    "tool.failed": "失败",
    "tool.input": "输入",
    "tool.output": "输出",
    "tool.showMore": "显示更多",
    "tool.showLess": "收起",
    "shell.stopped": "已停止",
    "shell.timedOut": "已超时",
    "shell.exit": "退出码 {{code}}",
    thought: "思考",
    thinking: "思考中",
    "duration.seconds": "{{count}} 秒",
    "duration.minutesSeconds": "{{minutes}} 分钟 {{seconds}} 秒",
    "activity.explored": "浏览了",
    "activity.edited": "编辑了",
    "activity.ran": "运行了",
    "activity.used": "使用了",
    "activity.files.other": "{{count}} 个文件",
    "activity.reads.other": "{{count}} 次读取",
    "activity.editedFiles.other": "{{count}} 个改动文件",
    "activity.searches.other": "{{count}} 次搜索",
    "activity.webSearches.other": "{{count}} 次网页搜索",
    "activity.pages.other": "{{count}} 个网页",
    "activity.skills.other": "{{count}} 个技能",
    "activity.commands.other": "{{count}} 条命令",
  },
}
