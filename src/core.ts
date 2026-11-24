// Pure logic shared by the GUI and the tests. No host imports here.

/** Kinds of assistant content a selection may start a fork from. */
export type ForkablePart = "text" | "reasoning"

/**
 * Parses a timeline part id. The host renders assistant content as `${messageID}:${type}:${index}` (tool parts use
 * the tool call id instead); user text uses the same shape, so callers still check the message type.
 */
export function parsePartId(id: string | undefined): { messageID: string; type: ForkablePart; index: number } | undefined {
  if (!id) return
  const match = /^(msg_[A-Za-z0-9_]+):(text|reasoning):(\d+)$/.exec(id)
  if (!match) return
  return { messageID: match[1]!, type: match[2] as ForkablePart, index: Number(match[3]) }
}

/** The fork's title: a source mark plus the first 20 characters (code points) of the original title. */
export function forkTitle(original: string | undefined): string {
  const head = [...(original ?? "").trim()].slice(0, 20).join("").trimEnd()
  return head ? `Fork · ${head}` : "Fork"
}

/**
 * Where `session.fork` should cut so the copy keeps everything up to and including `messageID`. `newestFirst` is one
 * page of the session's messages, newest first; `newer` is the oldest message of the pages read before it, if any.
 *
 * - `{ found: true, before: undefined }`: the message is the newest one; fork without `before` copies everything.
 * - `{ found: true, before }`: cut before the message right after it.
 * - `{ found: false, newer }`: not on this page; read the next page and pass `newer` along.
 */
export function boundaryIn(
  newestFirst: readonly { readonly id: string }[],
  messageID: string,
  newer?: string,
): { found: true; before: string | undefined } | { found: false; newer: string | undefined } {
  const index = newestFirst.findIndex((message) => message.id === messageID)
  if (index === -1) return { found: false, newer: newestFirst.at(-1)?.id ?? newer }
  return { found: true, before: index === 0 ? newer : newestFirst[index - 1]!.id }
}

/**
 * Orders message ids as the server does. Forked copies end in `_<n>`, which plain string order would put `_10`
 * before `_4`, so the numeric suffix compares as a number.
 */
export function compareMessageIds(a: string, b: string): number {
  const split = (id: string) => {
    const match = /^(.*)_(\d+)$/.exec(id)
    return match ? ([match[1]!, Number(match[2])] as const) : ([id, -1] as const)
  }
  const [ap, an] = split(a)
  const [bp, bn] = split(b)
  if (ap !== bp) return ap < bp ? -1 : 1
  return an - bn
}

/** Trims the selection the way the composer would receive it: no surrounding blank lines, inner text untouched. */
export function draftText(selection: string): string {
  return selection.replace(/^\s*\n/, "").replace(/\n\s*$/, "").trim()
}

// ---- Quotes: sent the way the host composer sends a timeline quote (app/src/composer/request.ts, comment-note.ts) ----

/** What the model reads for a quote without a source. Each line is prefixed, so quoted text cannot end the quote. */
export function formatQuote(text: string): string {
  const lines = text.split("\n").map((line) => `> ${line}`)
  return `The user quoted the following from earlier in the conversation:\n${lines.join("\n")}`
}

/**
 * The prompt for a message and its quote: the text the model reads, and the metadata the host's timeline (and the
 * panel) read to show the message as its text plus a quote card.
 */
export function composePrompt(body: string, quote: string | undefined) {
  const text = body.trim()
  if (!quote) return { text }
  return {
    text: [...(text ? [text] : []), formatQuote(quote)].join("\n"),
    metadata: { displayText: text, comments: [{ type: "quote", text: quote }], attachments: [] },
  }
}

/** A user message as the host shows it: the text the user typed and what they quoted, when its metadata says so. */
export function readPresentation(text: string, metadata: unknown): { body: string; quotes: string[] } {
  const value = record(metadata)
  if (typeof value.displayText !== "string" || !Array.isArray(value.comments)) return { body: text, quotes: [] }
  const quotes = value.comments.flatMap((comment) => {
    const item = record(comment)
    return item.type === "quote" && typeof item.text === "string" ? [item.text] : []
  })
  return { body: value.displayText, quotes }
}

// ---- Tool calls: named and folded as the host's timeline does (session-ui/src/timeline-next, "compact" preset) ----

/** A tool call, as much of `SessionMessageAssistantTool` as the panel reads. */
export type ToolCall = {
  readonly type: "tool"
  readonly id: string
  readonly name: string
  readonly state: {
    readonly status: string
    readonly input?: unknown
    readonly metadata?: unknown
    readonly content?: readonly { readonly type: string; readonly text?: string }[]
    readonly error?: { readonly type?: string; readonly message?: string }
  }
}
export type ThoughtPart = {
  readonly type: "reasoning"
  readonly text: string
  readonly time?: { readonly created?: number; readonly completed?: number }
}
export type TextPart = { readonly type: "text"; readonly text: string }
export type TurnPart = ToolCall | ThoughtPart | TextPart

/** What the agent was doing with a call; the most consequential names a group: Edited over Ran over Used over Explored. */
export type ToolMode = "explore" | "edit" | "run" | "tool"

// Sessions migrated from v1 keep the tools' old names.
const RENAMED: Record<string, string> = { bash: "shell", task: "subagent", apply_patch: "patch" }
const MODES: Record<string, ToolMode> = {
  read: "explore",
  list: "explore",
  glob: "explore",
  grep: "explore",
  webfetch: "explore",
  websearch: "explore",
  skill: "explore",
  edit: "edit",
  write: "edit",
  patch: "edit",
  shell: "run",
  execute: "run",
}
/** Never shown, as in the host. */
const HIDDEN = new Set(["todowrite"])

export const toolName = (tool: ToolCall) => RENAMED[tool.name] ?? tool.name
export const toolMode = (tool: ToolCall): ToolMode => MODES[toolName(tool)] ?? "tool"

const record = (value: unknown): Record<string, unknown> =>
  value && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : {}
const text = (value: unknown) => (typeof value === "string" && value ? value : undefined)

/** The call's input. While the model still writes it, it is partial JSON, which reads as nothing until it is whole. */
export function toolInput(tool: ToolCall): Record<string, unknown> {
  const input = tool.state.input
  if (typeof input !== "string") return record(input)
  try {
    return record(JSON.parse(input))
  } catch {
    return {}
  }
}

export const toolMetadata = (tool: ToolCall) => record(tool.state.metadata)

/** The call's text output. */
export function toolOutput(tool: ToolCall): string {
  return (tool.state.content ?? []).flatMap((item) => (item.type === "text" && item.text ? [item.text] : [])).join("\n")
}

export const toolPending = (tool: ToolCall) => tool.state.status === "streaming" || tool.state.status === "running"

/** The user stopped it, by stopping the turn or cancelling its command: it shows as a call that ran, not a failure. */
export function toolStopped(tool: ToolCall): boolean {
  if (tool.state.status !== "error") return false
  const type = tool.state.error?.type?.toLowerCase() ?? ""
  return type.includes("abort") || type.includes("interrupt") || tool.state.error?.message === "Command cancelled"
}

/**
 * How a command ended, where it did not succeed, as the host's shell rows say it (timeline-next/tools/shell.tsx
 * `shellOutcome`): stopped is neutral; a timeout or a non-zero exit is a failure. `exit` counts only as a number: the
 * server reports "NaN" and "Infinity" as strings.
 */
export function shellOutcome(metadata: unknown): { tone: "neutral" | "danger"; label: Label } | undefined {
  const value = record(metadata)
  if (value.interrupted === true || value.status === "killed") return { tone: "neutral", label: { key: "shell.stopped" } }
  if (value.timeout === true || value.status === "timeout") return { tone: "danger", label: { key: "shell.timedOut" } }
  if (typeof value.exit === "number" && value.exit !== 0)
    return { tone: "danger", label: { key: "shell.exit", params: { code: String(value.exit) } } }
}

/** Whether a call failed: it errored, or the command it ran exited non-zero. A call the user stopped did not fail. */
export function toolFailed(tool: ToolCall): boolean {
  if (tool.state.status === "error") return !toolStopped(tool)
  return toolName(tool) === "shell" && shellOutcome(tool.state.metadata)?.tone === "danger"
}

export const basename = (path: string) => path.replace(/[\\/]+$/, "").split(/[\\/]/).pop() ?? path

/** A path's folder, relative to the project root when it lies inside it, as the host's rows show folders. */
export function folder(path: string | undefined, root?: string): string {
  const value = path ?? "/"
  const index = Math.max(value.lastIndexOf("/"), value.lastIndexOf("\\"))
  // A bare name has no folder of its own.
  const directory = index < 0 ? "" : index === 0 ? "/" : value.slice(0, index)
  if (!root || root === "/" || !directory) return directory
  const base = root.replace(/[\\/]+$/, "")
  const prefix = `${base}/`
  if (directory === base) return ""
  return directory.startsWith(prefix) ? directory.slice(prefix.length) : directory
}

/** A translatable title: a catalog key and its placeholders. */
export type Label = { readonly key: string; readonly params?: Record<string, string> }

/** One row's title line, as the host's BasicTool trigger shows it: title, a muted subtitle, then `key=value` args. */
export type ToolSummary = { title: Label; subtitle?: string; args: string[]; mono?: boolean }

// The keys the host's generic row reads its subtitle from, in order; every other scalar is an arg.
const LABEL_KEYS = ["description", "query", "url", "path", "pattern", "name"]

export function toolSummary(tool: ToolCall, root?: string): ToolSummary {
  const input = toolInput(tool)
  const path = text(input.path)
  switch (toolName(tool)) {
    case "read":
      return {
        title: { key: "tool.read" },
        subtitle: path && basename(path),
        args: [
          ...(input.offset === undefined ? [] : [`offset=${input.offset}`]),
          ...(input.limit === undefined ? [] : [`limit=${input.limit}`]),
        ],
      }
    case "list":
      return { title: { key: "tool.list" }, subtitle: folder(path, root), args: [] }
    case "glob":
      return { title: { key: "tool.glob" }, subtitle: folder(path, root), args: pick(input, ["pattern"]) }
    case "grep":
      return { title: { key: "tool.grep" }, subtitle: folder(path, root), args: pick(input, ["pattern", "include"]) }
    case "webfetch":
      return { title: { key: "tool.webfetch" }, subtitle: text(input.url), args: [] }
    case "websearch":
      return { title: { key: "tool.websearch" }, subtitle: text(input.query), args: [] }
    case "shell":
      return { title: { key: "tool.shell" }, subtitle: text(input.command), args: [], mono: true }
    case "execute":
      return { title: { key: "tool.execute" }, subtitle: text(input.description), args: [] }
    case "edit":
      return { title: { key: "tool.edit" }, subtitle: path && basename(path), args: [] }
    case "write":
      return { title: { key: "tool.write" }, subtitle: path && basename(path), args: [] }
    case "patch": {
      const files = changedFiles(tool).map((file) => basename(file.file))
      return { title: { key: "tool.patch" }, subtitle: files.join(", ") || undefined, args: [] }
    }
    case "subagent": {
      const agent = text(input.agent)
      return {
        title: agent ? { key: "tool.agent", params: { name: agent[0]!.toUpperCase() + agent.slice(1) } } : { key: "tool.agent.default" },
        subtitle: text(input.description),
        args: [],
      }
    }
    case "skill":
      return { title: { key: "tool.skill" }, subtitle: text(toolMetadata(tool).name) ?? text(input.name) ?? text(input.id), args: [] }
    case "question":
      return { title: { key: "tool.questions" }, args: [] }
    default: {
      const subtitle = LABEL_KEYS.map((key) => text(input[key])).find(Boolean)
      const args = Object.entries(input)
        .filter(([key, value]) => !LABEL_KEYS.includes(key) && ["string", "number", "boolean"].includes(typeof value))
        .map(([key, value]) => `${key}=${value}`)
        .slice(0, 3)
      return { title: { key: "tool.called", params: { tool: tool.name } }, subtitle, args }
    }
  }
}

function pick(input: Record<string, unknown>, keys: string[]) {
  return keys.flatMap((key) => (text(input[key]) ? [`${key}=${input[key]}`] : []))
}

/** A file an edit, write or patch changed, from the call's metadata: its unified diff and line counts. */
export type ChangedFile = { file: string; patch: string; additions: number; deletions: number }

export function changedFiles(tool: ToolCall): ChangedFile[] {
  const files = toolMetadata(tool).files
  if (!Array.isArray(files)) return []
  return files.flatMap((value) => {
    const file = record(value)
    if (typeof file.file !== "string" || typeof file.patch !== "string") return []
    const additions = typeof file.additions === "number" ? file.additions : 0
    const deletions = typeof file.deletions === "number" ? file.deletions : 0
    return [{ file: file.file, patch: file.patch, additions, deletions }]
  })
}

/** A unified diff from its first hunk on: the file headers repeat what the row already says. */
export function diffBody(patch: string): string {
  const lines = patch.split("\n")
  const start = lines.findIndex((line) => line.startsWith("@@"))
  return (start === -1 ? lines : lines.slice(start)).join("\n").replace(/\n+$/, "")
}

/** A diff from an edit's own strings, for a call whose metadata has none yet: what it removes, then what it adds. */
export function stringDiff(before: string, after: string): string {
  const side = (value: string, mark: string) => (value ? value.split("\n").map((line) => mark + line) : [])
  return [...side(before, "-"), ...side(after, "+")].join("\n")
}

/** A phrase of a group's label: a count under a plural key, a catalog key, or a literal (a file or tool name). */
export type Phrase = { readonly plural: string; readonly count: number } | { readonly key: string } | string

// The titles a group's label names calls by (context-group.tsx `toolTitle`).
const GROUP_TITLES: Record<string, string> = {
  read: "tool.read",
  list: "tool.list",
  glob: "tool.glob",
  grep: "tool.grep",
  webfetch: "tool.fetch",
  websearch: "tool.searchWeb",
  subagent: "tool.agent.default",
  shell: "tool.shell",
  execute: "tool.execute",
  edit: "tool.edit",
  write: "tool.write",
  patch: "tool.patch",
  question: "tool.questions",
  skill: "tool.skill",
}

const PRIORITY: ToolMode[] = ["edit", "run", "tool", "explore"]

/**
 * Names a stretch of calls by its main mode, then what the others did: "Explored 3 files, 1 search · 2 commands".
 * Undefined for a stretch without calls.
 */
export function activityLabel(tools: readonly ToolCall[]): { verb: string; main: Phrase[]; others: Phrase[] } | undefined {
  const modes = new Set(tools.map(toolMode))
  const mode = PRIORITY.find((item) => modes.has(item))
  if (!mode) return
  const calls = (item: ToolMode) => tools.filter((tool) => toolMode(tool) === item)
  const count = (names: string[]) => tools.filter((tool) => names.includes(toolName(tool))).length
  const counted = (key: string, value: number): Phrase[] => (value > 0 ? [{ plural: key, count: value }] : [])
  const reads = new Set(tools.flatMap((tool) => (toolName(tool) === "read" ? [text(toolInput(tool).path) ?? tool.id] : [])))
  const files = [
    ...new Set(
      calls("edit").flatMap((tool) => {
        const changed = changedFiles(tool).map((file) => file.file)
        const path = text(toolInput(tool).path)
        return changed.length ? changed : path ? [path] : []
      }),
    ),
  ]
  const explore = (main: boolean) => [
    ...counted(main ? "activity.files" : "activity.reads", reads.size),
    ...counted("activity.searches", count(["glob", "grep", "list"])),
    ...counted("activity.webSearches", count(["websearch"])),
    ...counted("activity.pages", count(["webfetch"])),
    ...counted("activity.skills", count(["skill"])),
  ]
  const commands = counted("activity.commands", calls("run").length)
  // A tool the host has no title for is named as it is; "=" marks those while they are deduplicated with the keys.
  const used = [...new Set(calls("tool").map((tool) => GROUP_TITLES[toolName(tool)] ?? `=${tool.name}`))].map(
    (title): Phrase => (title.startsWith("=") ? title.slice(1) : { key: title }),
  )
  const others: Record<ToolMode, Phrase[]> = {
    explore: explore(false),
    edit: counted("activity.editedFiles", files.length),
    run: commands,
    tool: used,
  }
  // A few files read better by name; past that, the count says more than a list that truncates.
  const main: Record<ToolMode, Phrase[]> = {
    edit: files.length <= 3 ? files.map(basename) : counted("activity.files", files.length),
    run: commands,
    tool: used,
    explore: explore(true),
  }
  return {
    verb: `activity.${{ explore: "explored", edit: "edited", run: "ran", tool: "used" }[mode]}`,
    main: main[mode],
    others: PRIORITY.filter((item) => item !== mode).flatMap((item) => others[item]),
  }
}

/** One row of an assistant turn: its text, a stretch of calls and thoughts folded into one row, or thoughts alone. */
export type TurnRow<P extends TurnPart = TurnPart> =
  | { kind: "text"; key: string; part: Extract<P, TextPart> }
  | { kind: "group"; key: string; parts: { key: string; part: Exclude<P, TextPart> }[] }
  | { kind: "thoughts"; key: string; parts: { key: string; part: Extract<P, ThoughtPart> }[] }

/**
 * Folds a turn's parts as the host's compact timeline does: text stands on its own, and every stretch of calls and
 * thoughts between texts folds into one row; a stretch of thoughts alone stays thoughts. Keys come from the stretch's
 * first part, so a row keeps its key, and its open state, while the stretch grows; a stretch of thoughts that gains a
 * call keeps its key too, and only changes how it draws.
 *
 * `live` is the key of the part the model is writing now, if any: as in the host, only the running turn's last part
 * is still being written. A thought anywhere else is finished, even one a stop or a fork cut off before it ended.
 */
export function foldTurn<P extends TurnPart>(parts: readonly { key: string; part: P }[], live?: string): TurnRow<P>[] {
  const rows: TurnRow<P>[] = []
  let stretch: { key: string; part: Exclude<P, TextPart> }[] = []
  const flush = () => {
    const first = stretch[0]
    if (!first) return
    const key = `stretch:${first.key}`
    if (stretch.every((item) => item.part.type === "reasoning")) rows.push({ kind: "thoughts", key, parts: stretch as never })
    else rows.push({ kind: "group", key, parts: stretch })
    stretch = []
  }
  for (const item of parts) {
    const part = item.part
    if (part.type === "text") {
      if (!part.text.trim()) continue
      flush()
      rows.push({ kind: "text", key: `text:${item.key}`, part: part as Extract<P, TextPart> })
      continue
    }
    if (part.type === "reasoning") {
      // A finished thought without text has nothing to open; the one being written shows that the model thinks.
      if (!part.text.trim() && item.key !== live) continue
    } else {
      const name = toolName(part)
      if (HIDDEN.has(name)) continue
      // A question shows once answered, as in the host; while it waits, the host asks it in its own dock.
      if (name === "question" && toolPending(part)) continue
      // A call stopped before the model finished writing it did nothing.
      if (toolStopped(part) && Object.keys(toolInput(part)).length === 0) continue
    }
    stretch.push(item as { key: string; part: Exclude<P, TextPart> })
  }
  flush()
  return rows
}

/**
 * Keys for a message's parts that survive the server re-reading the message: a call by its id, text and thoughts by
 * their count among parts of their type, as the host keys them (timeline-next/projection.ts).
 */
export function partKeys(messageID: string, parts: readonly TurnPart[]): string[] {
  const counts = { text: 0, reasoning: 0 }
  return parts.map((part) =>
    part.type === "tool" ? `${messageID}:tool:${part.id}` : `${messageID}:${part.type}:${counts[part.type]++}`,
  )
}
