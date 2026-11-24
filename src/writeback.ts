// Controlled write-back: when a fork closes, what it settled goes back to the session it came from as one notice.
// Pure logic and the flow with its effects injected, so the tests drive every branch. No host imports here.

import { basename, readPresentation, toolFailed, toolInput, toolName, changedFiles, type ToolCall } from "./core.ts"

// ---- Configuration ------------------------------------------------------------------------------------------------

export type WritebackConfig = {
  /** Writes back at all. */
  readonly enabled: boolean
  /** The summary's three sections together, in characters (code points). */
  readonly maxChars: number
  /** Asks "Merge into the main thread?" before writing. */
  readonly confirm: boolean
  /** The model that writes the summary, through the server's own credentials; `variant` as the model lists them. */
  readonly model: { readonly providerID: string; readonly id: string; readonly variant?: string }
  /** One summary call; past it the write-back is skipped. */
  readonly timeoutMs: number
}

export const WRITEBACK_DEFAULTS: WritebackConfig = {
  enabled: true,
  maxChars: 300,
  confirm: true,
  // Without thinking: with it, one summary of a long fork took over 20 seconds; without, about two.
  model: { providerID: "deepseek", id: "deepseek-flash", variant: "none" },
  timeoutMs: 5000,
}

/** The model as configured, then the same one without its variant, which some resolution paths do not know. */
export function modelAttempts(model: WritebackConfig["model"]): WritebackConfig["model"][] {
  return model.variant ? [model, { providerID: model.providerID, id: model.id }] : [model]
}

/** A failure that says the model reference itself, rather than the call, was wrong: worth one retry without a variant. */
export function modelRefused(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error)
  return /model not found|model unavailable|variant unavailable|model\.variant/i.test(message)
}

const record = (value: unknown): Record<string, unknown> =>
  value && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : {}
const string = (value: unknown) => (typeof value === "string" ? value.trim() : "")

/**
 * Reads `options.writeback` from the plugin's entry in `opencode.json`; anything missing or malformed keeps its default.
 * `model` is `"<provider>/<model>"` or `"<provider>/<model>#<variant>"`.
 */
export function writebackConfig(options: unknown): WritebackConfig {
  const value = record(record(options).writeback)
  const positive = (input: unknown, fallback: number) =>
    typeof input === "number" && Number.isFinite(input) && input > 0 ? Math.round(input) : fallback
  const [model = "", variant] = string(value.model).split("#")
  const slash = model.indexOf("/")
  return {
    enabled: typeof value.enabled === "boolean" ? value.enabled : WRITEBACK_DEFAULTS.enabled,
    maxChars: positive(value.maxChars, WRITEBACK_DEFAULTS.maxChars),
    confirm: typeof value.confirm === "boolean" ? value.confirm : WRITEBACK_DEFAULTS.confirm,
    model:
      slash > 0 && slash < model.length - 1
        ? { providerID: model.slice(0, slash), id: model.slice(slash + 1), ...(variant ? { variant } : {}) }
        : WRITEBACK_DEFAULTS.model,
    timeoutMs: positive(value.timeoutMs, WRITEBACK_DEFAULTS.timeoutMs),
  }
}

// ---- What the fork did --------------------------------------------------------------------------------------------

/** As much of a session message as the write-back reads. */
export type ForkMessage = {
  readonly id: string
  readonly type: string
  readonly time?: { readonly created?: number }
  readonly text?: string
  readonly metadata?: unknown
  readonly content?: readonly { readonly type: string; readonly text?: string }[]
}

/**
 * The fork's own messages: the copied history keeps its original times, so what the fork added is what was created
 * once the fork session existed.
 */
export function ownMessages<M extends ForkMessage>(messages: readonly M[], since: number): M[] {
  return messages.filter((message) => (message.time?.created ?? 0) >= since)
}

const tools = (message: ForkMessage) =>
  message.type === "assistant" ? ((message.content ?? []).filter((part) => part.type === "tool") as unknown as ToolCall[]) : []

/** A path as the project names it: relative to the root when it lies inside it. */
export function projectPath(path: string, root?: string): string {
  const base = root?.replace(/[\\/]+$/, "")
  if (!base) return path
  return path.startsWith(`${base}/`) ? path.slice(base.length + 1) : path
}

/** The files the fork's own calls changed, in the order they were first changed. Failed calls changed nothing. */
export function changedPaths(messages: readonly ForkMessage[], root?: string): string[] {
  const paths = messages.flatMap((message) =>
    tools(message).flatMap((tool) => {
      if (!["edit", "write", "patch"].includes(toolName(tool)) || tool.state.status !== "completed" || toolFailed(tool))
        return []
      const files = changedFiles(tool).map((file) => file.file)
      const path = toolInput(tool).path
      return files.length ? files : typeof path === "string" && path ? [path] : []
    }),
  )
  return [...new Set(paths.map((path) => projectPath(path, root)))]
}

/** The fork's own messages include a reply: a fork that only holds an unanswered question settled nothing. */
export const answered = (messages: readonly ForkMessage[]) =>
  messages.some(
    (message) =>
      message.type === "assistant" &&
      (message.content ?? []).some((part) => part.type === "tool" || (part.type === "text" && !!part.text?.trim())),
  )

/** The fork's own conversation as the summary model reads it, newest kept when it runs long. */
export function transcriptText(messages: readonly ForkMessage[], limit = 12000): string {
  const lines = messages.flatMap((message) => {
    if (message.type === "user") {
      const shown = readPresentation(message.text ?? "", message.metadata)
      return [
        ...shown.quotes.map((quote) => `User quoted: ${quote}`),
        ...(shown.body.trim() ? [`User: ${shown.body.trim()}`] : []),
      ]
    }
    if (message.type !== "assistant") return []
    return (message.content ?? []).flatMap((part) => {
      if (part.type === "text" && part.text?.trim()) return [`Assistant: ${part.text.trim()}`]
      if (part.type !== "tool") return []
      const tool = part as unknown as ToolCall
      const input = toolInput(tool)
      const target = [input.path, input.command, input.pattern, input.query, input.url].find(
        (value) => typeof value === "string" && value,
      )
      return [`Tool ${toolName(tool)}${target ? `: ${String(target).slice(0, 200)}` : ""}${toolFailed(tool) ? " (failed)" : ""}`]
    })
  })
  const text = lines.join("\n\n")
  return text.length > limit ? `…\n${text.slice(text.length - limit)}` : text
}

// ---- The summary --------------------------------------------------------------------------------------------------

export const MAX_FILES = 10
export const MAX_OPEN = 3

export type Summary = {
  /** What the fork settled, two or three sentences; empty when it settled nothing. */
  readonly conclusion: string
  /** Changed files with one sentence each, at most `MAX_FILES`. */
  readonly files: readonly { readonly path: string; readonly note: string }[]
  /** Changed files past the list. */
  readonly more: number
  /** What is still open, at most `MAX_OPEN`. */
  readonly open: readonly string[]
}

/** What the summary model is asked; it answers with one JSON object. */
export function summaryPrompt(transcript: string, files: readonly string[], maxChars: number): string {
  return [
    "You summarise a side conversation (a fork) so its outcome can return to the main conversation it branched from.",
    "Reply with one JSON object and nothing else:",
    '{"conclusion": "...", "files": {"<path>": "..."}, "open": ["..."]}',
    `- conclusion: what the fork finally decided or concluded, two or three short sentences, at most ${Math.round(maxChars * 0.4)} characters. If it only asked or explained something and settled nothing, use an empty string.`,
    `- files: for each changed file listed below, what changed, at most ${Math.round(maxChars * 0.08)} characters. Only those paths.`,
    `- open: what is still undecided or left to do, at most ${MAX_OPEN} items of at most ${Math.round(maxChars * 0.1)} characters each; an empty array if nothing.`,
    `- Write in the language the conversation uses. Everything together must stay under ${maxChars} characters, so be terse.`,
    "",
    "Changed files:",
    ...(files.length ? files.map((file) => `- ${file}`) : ["(none)"]),
    "",
    "Conversation:",
    transcript,
  ].join("\n")
}

/** The model's answer as a summary over the files the fork changed; undefined when it is not the JSON asked for. */
export function parseSummary(raw: string, files: readonly string[]): Summary | undefined {
  const start = raw.indexOf("{")
  const end = raw.lastIndexOf("}")
  if (start === -1 || end <= start) return
  let value: Record<string, unknown>
  try {
    value = record(JSON.parse(raw.slice(start, end + 1)))
  } catch {
    return
  }
  const notes = record(value.files)
  const open = Array.isArray(value.open) ? value.open.map(string).filter(Boolean) : []
  return {
    conclusion: string(value.conclusion),
    // The list comes from the calls, not the model: a model may drop a file or invent one.
    files: files.slice(0, MAX_FILES).map((path) => ({ path, note: string(notes[path] ?? notes[basename(path)]) })),
    more: Math.max(0, files.length - MAX_FILES),
    open: open.slice(0, MAX_OPEN),
  }
}

/** A summary with nothing in it: no file changed and nothing was concluded. */
export const settledNothing = (summary: Summary) => !summary.conclusion && summary.files.length === 0 && summary.more === 0

/** Each section's heading with its colon, e.g. "结论：" or "Conclusion: ". */
export type SummaryLabels = {
  readonly conclusion: string
  readonly changes: string
  readonly open: string
  readonly none: string
  /** Between a file and its note. */
  readonly separator: string
  /** `{{count}}` is the number of files past the list. */
  readonly more: (count: number) => string
}

/** The three sections, as the main session's notice shows them and its model reads them. */
export function formatSummary(summary: Summary, labels: SummaryLabels): string {
  const list = (items: string[]) => (items.length ? items.map((item) => `- ${item}`) : [`- ${labels.none}`])
  return [
    `${labels.conclusion}${summary.conclusion || labels.none}`,
    labels.changes.trimEnd(),
    ...list([
      ...summary.files.map((file) => (file.note ? `${file.path}${labels.separator}${file.note}` : file.path)),
      ...(summary.more ? [labels.more(summary.more)] : []),
    ]),
    labels.open.trimEnd(),
    ...list([...summary.open]),
  ].join("\n")
}

export const length = (text: string) => [...text].length
const cut = (text: string, size: number) => {
  const chars = [...text]
  return chars.length <= size ? text : `${chars.slice(0, Math.max(0, size - 1)).join("")}…`
}

/** Shorter than this a note or an open item says nothing; it is dropped rather than cut further. */
const SHORTEST = 16

/**
 * Shrinks a summary until its three sections fit `maxChars`. The conclusion matters most, so file notes and open
 * items are cut first, the longest first, so each keeps its share; then the conclusion is cut; past that, notes go,
 * then open items from the end, then files fold into "N more". The section headings always stay.
 */
export function fitSummary(summary: Summary, labels: SummaryLabels, maxChars: number): Summary {
  let current = summary
  const over = () => length(formatSummary(current, labels)) - maxChars
  const pieces = (value: Summary) => [...value.files.map((file) => file.note), ...value.open]
  const rebuild = (value: Summary, next: string[]): Summary => ({
    ...value,
    files: value.files.map((file, index) => ({ ...file, note: next[index]! })),
    open: value.open.map((_, index) => next[value.files.length + index]!),
  })
  while (over() > 0) {
    const next = pieces(current)
    const sizes = next.map(length)
    const top = Math.max(0, ...sizes)
    if (top <= SHORTEST) break
    const index = sizes.indexOf(top)
    const second = Math.max(0, ...sizes.filter((_, at) => at !== index))
    // Down to the next longest piece, or only as far as the excess needs; ties go one character at a time.
    const target = Math.max(SHORTEST, second, top - over())
    next[index] = cut(next[index]!, target < top ? target : top - 1)
    current = rebuild(current, next)
  }
  if (over() > 0 && length(current.conclusion) > SHORTEST)
    current = { ...current, conclusion: cut(current.conclusion, Math.max(SHORTEST, length(current.conclusion) - over())) }
  for (let index = current.files.length - 1; index >= 0 && over() > 0; index--)
    current = { ...current, files: current.files.map((file, at) => (at === index ? { ...file, note: "" } : file)) }
  while (over() > 0 && current.open.length > 0) current = { ...current, open: current.open.slice(0, -1) }
  while (over() > 0 && current.files.length > 0)
    current = { ...current, files: current.files.slice(0, -1), more: current.more + 1 }
  if (over() > 0) current = { ...current, conclusion: cut(current.conclusion, Math.max(1, length(current.conclusion) - over())) }
  return current
}

// ---- The marker -----------------------------------------------------------------------------------------------------

/** Marks a write-back notice in its metadata: the host reads `source` to tell notices apart; ours is none of its own. */
export const WRITEBACK_SOURCE = "session-fork"

export type WritebackMeta = {
  readonly source: typeof WRITEBACK_SOURCE
  readonly forkID: string
  readonly hash: string
  readonly title: string
  readonly conclusion: string
  readonly files: readonly { readonly path: string; readonly note: string }[]
  readonly more: number
  readonly open: readonly string[]
}

/** A write-back notice's marker, when the metadata carries one. */
export function writebackMeta(metadata: unknown): WritebackMeta | undefined {
  const value = record(metadata)
  if (value.source !== WRITEBACK_SOURCE || typeof value.forkID !== "string" || typeof value.hash !== "string") return
  const files = Array.isArray(value.files)
    ? value.files.flatMap((item) => {
        const file = record(item)
        return typeof file.path === "string" ? [{ path: file.path, note: string(file.note) }] : []
      })
    : []
  return {
    source: WRITEBACK_SOURCE,
    forkID: value.forkID,
    hash: value.hash,
    title: string(value.title),
    conclusion: string(value.conclusion),
    files,
    more: typeof value.more === "number" ? value.more : 0,
    open: Array.isArray(value.open) ? value.open.map(string).filter(Boolean) : [],
  }
}

/** FNV-1a over the UTF-16 code units, as 8 hex digits: enough to tell two summaries of one fork apart. */
export function contentHash(text: string): string {
  let hash = 0x811c9dc5
  for (let index = 0; index < text.length; index++) {
    hash ^= text.charCodeAt(index)
    hash = Math.imul(hash, 0x01000193) >>> 0
  }
  return hash.toString(16).padStart(8, "0")
}

/** The fork's name in the notice header, without the `Fork · ` its title starts with. */
export const forkName = (title: string | undefined) => (title ?? "").replace(/^Fork\s*·\s*/, "").trim() || "Fork"

/** What the main session's model reads: the summary in a tag that says where it came from. */
export function writebackText(input: { forkID: string; title: string; body: string }): string {
  const title = input.title.replace(/"/g, "'")
  return [
    `<fork-writeback fork="${input.forkID}" title="${title}">`,
    "The user worked through a side question in a fork of this session and closed it. What it settled, for reference; it needs no reply.",
    "",
    input.body,
    "</fork-writeback>",
  ].join("\n")
}

/**
 * What the fork keeps about its write-back, in its own session metadata, so a second close, also after a restart,
 * never writes twice: the hash it wrote, or the state of the fork the user declined to merge.
 */
export type WritebackState = { readonly written?: string; readonly declined?: string }

export const STATE_KEY = "sessionFork"

export function writebackState(metadata: unknown): WritebackState {
  const value = record(record(metadata)[STATE_KEY])
  return {
    ...(typeof value.written === "string" ? { written: value.written } : {}),
    ...(typeof value.declined === "string" ? { declined: value.declined } : {}),
  }
}

/** Where the fork stands: the user declines a fork as it is; one that went on since asks again. */
export const forkSignature = (messages: readonly ForkMessage[]) => contentHash(messages.map((message) => message.id).join(","))

// ---- The flow -----------------------------------------------------------------------------------------------------

export type WritebackOutcome =
  | { readonly status: "written"; readonly hash: string }
  | { readonly status: "declined" }
  | { readonly status: "skipped"; readonly reason: string }

export type WritebackDeps = {
  readonly config: WritebackConfig
  readonly forkID: string
  readonly labels: SummaryLabels
  /** The notice header, from the fork's name. */
  readonly description: (name: string) => string
  /** The fork session and its messages, oldest first. */
  readonly load: () => Promise<{
    readonly title?: string
    readonly created: number
    readonly mainID?: string
    readonly root?: string
    readonly metadata?: unknown
    readonly messages: readonly ForkMessage[]
  }>
  /** The main session already holds a write-back of this fork, delivered or still waiting in its inbox. */
  readonly existing: (mainID: string, since: number) => Promise<boolean>
  /** One call to the summary model; rejects on any failure, and is aborted past the timeout. */
  readonly generate: (prompt: string, model: WritebackConfig["model"], signal: AbortSignal) => Promise<string>
  /** Asks the user, showing what would be merged. */
  readonly confirm: (preview: { title: string; body: string }) => Promise<boolean>
  readonly write: (input: { mainID: string; text: string; description: string; metadata: WritebackMeta }) => Promise<void>
  /** Keeps the state in the fork's metadata. */
  readonly remember: (state: WritebackState, metadata: unknown) => Promise<void>
  /** One line per run that does not write. */
  readonly log: (line: string) => void
  readonly timer?: { set: (run: () => void, ms: number) => unknown; clear: (handle: unknown) => void }
}

function withTimeout<T>(run: (signal: AbortSignal) => Promise<T>, ms: number, timer: NonNullable<WritebackDeps["timer"]>) {
  const controller = new AbortController()
  return new Promise<T>((resolve, reject) => {
    const handle = timer.set(() => {
      controller.abort()
      reject(new Error(`timed out after ${ms}ms`))
    }, ms)
    run(controller.signal).then(
      (value) => {
        timer.clear(handle)
        resolve(value)
      },
      (error) => {
        timer.clear(handle)
        reject(error)
      },
    )
  })
}

const defaultTimer = { set: (run: () => void, ms: number) => setTimeout(run, ms), clear: (handle: unknown) => clearTimeout(handle as never) }

/**
 * Writes back one fork that just closed, or says why not. Never throws: whatever fails, the close already happened,
 * and the run ends with one log line.
 */
export async function runWriteback(deps: WritebackDeps): Promise<WritebackOutcome> {
  const skip = (reason: string): WritebackOutcome => {
    deps.log(`[session-fork] writeback skipped (${deps.forkID}): ${reason}`)
    return { status: "skipped", reason }
  }
  try {
    if (!deps.config.enabled) return skip("disabled")
    const fork = await deps.load()
    const state = writebackState(fork.metadata)
    if (state.written) return skip("already written")
    if (!fork.mainID) return skip("no main session")
    const own = ownMessages(fork.messages, fork.created)
    if (!answered(own)) return skip("nothing happened in the fork")
    const signature = forkSignature(own)
    if (deps.config.confirm && state.declined === signature) return skip("declined before, nothing new since")
    if (await deps.existing(fork.mainID, fork.created)) {
      await deps.remember({ ...state, written: "existing" }, fork.metadata).catch(() => {})
      return skip("already written")
    }

    const files = changedPaths(own, fork.root)
    const prompt = summaryPrompt(transcriptText(own), files, deps.config.maxChars)
    const attempts = modelAttempts(deps.config.model)
    let raw: string
    try {
      raw = await withTimeout(
        async (signal) => {
          // The variant may be one the server's model resolution path does not list: drop it once and ask again.
          for (const [index, model] of attempts.entries()) {
            try {
              return await deps.generate(prompt, model, signal)
            } catch (error) {
              if (index === attempts.length - 1 || !modelRefused(error)) throw error
            }
          }
          throw new Error("no model to ask")
        },
        deps.config.timeoutMs,
        deps.timer ?? defaultTimer,
      )
    } catch (error) {
      return skip(`summary failed: ${error instanceof Error ? error.message : String(error)}`)
    }
    const parsed = parseSummary(raw, files)
    if (!parsed) return skip("summary was not the JSON asked for")
    if (settledNothing(parsed)) return skip("no changes and no conclusion")
    const summary = fitSummary(parsed, deps.labels, deps.config.maxChars)
    const body = formatSummary(summary, deps.labels)
    const name = forkName(fork.title)

    if (deps.config.confirm && !(await deps.confirm({ title: name, body }))) {
      await deps.remember({ ...state, declined: signature }, fork.metadata).catch(() => {})
      deps.log(`[session-fork] writeback declined (${deps.forkID})`)
      return { status: "declined" }
    }

    const hash = contentHash(body)
    try {
      await deps.write({
        mainID: fork.mainID,
        description: deps.description(name),
        text: writebackText({ forkID: deps.forkID, title: name, body }),
        metadata: { source: WRITEBACK_SOURCE, forkID: deps.forkID, hash, title: name, ...summary },
      })
    } catch (error) {
      return skip(`write failed: ${error instanceof Error ? error.message : String(error)}`)
    }
    // The notice is written; a failure to remember it is caught by `existing` on the next close.
    await deps.remember({ written: hash }, fork.metadata).catch(() => {})
    return { status: "written", hash }
  } catch (error) {
    return skip(`failed: ${error instanceof Error ? error.message : String(error)}`)
  }
}
