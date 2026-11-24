import { Panel, Plugin, Style, type MountedSession, type PanelProps } from "@opencode/plugin/gui"
import type { SessionMessageInfo } from "@opencode/client/promise"
import { createData } from "@opencode/client/solid"
import {
  For,
  Match,
  Show,
  Switch,
  createEffect,
  createMemo,
  createRoot,
  createSignal,
  getOwner,
  onCleanup,
  onMount,
  runWithOwner,
  untrack,
} from "solid-js"
import { createStore } from "solid-js/store"
import {
  boundaryIn,
  compareMessageIds,
  composePrompt,
  draftText,
  foldTurn,
  forkTitle,
  parsePartId,
  partKeys,
  readPresentation,
  type TurnPart,
  type TurnRow,
} from "./core.ts"
import { createTimeline, timelineMessages, type Disclosures } from "./timeline.tsx"
import {
  STATE_KEY,
  runWriteback,
  writebackConfig,
  writebackMeta,
  type ForkMessage,
  type SummaryLabels,
  type WritebackMeta,
} from "./writeback.ts"
import css from "./style.css?inline"

const PANEL = "fork"
const TAB_PREFIX = "fork-"
/** The host's selection toolbar; the Fork button joins it when it shows. */
const HOST_TOOLBAR = "[data-component=timeline-quote]"
/** Everything this plugin renders carries it, so selections inside the fork panel never fork again. */
const OWN = "data-session-fork"

type Candidate = { session: MountedSession; messageID: string; text: string; rect: DOMRect }

export default Plugin.define({
  i18n: {
    en: {
      fork: "Fork",
      "fork.title": "Fork from here: new session with the history up to this message",
      "fork.failed": "Fork failed",
      "panel.title": "Fork",
      "panel.openTab": "Open in tab",
      "panel.stop": "Stop",
      "panel.running": "Generating…",
      "panel.input": "Message (Enter to send, Shift+Enter for a new line)",
      "panel.send": "Send",
      "panel.quote": "Quote",
      "panel.quote.remove": "Remove quote",
      "panel.send.failed": "Send failed",
      "panel.permission": "This fork is waiting for a permission. Open it in a tab to answer.",
      "panel.loading": "Loading…",
      "panel.empty": "No messages in this fork yet. Send one below.",
      "writeback.from": "From Fork · {{name}}",
      "writeback.confirm.title": "Merge into the main thread?",
      "writeback.confirm.yes": "Merge",
      "writeback.confirm.no": "Don't merge",
      "writeback.conclusion": "Conclusion: ",
      "writeback.changes": "Changes:",
      "writeback.open": "Still open:",
      "writeback.none": "none",
      "writeback.separator": ": ",
      "writeback.more.one": "{{count}} more file",
      "writeback.more.other": "{{count}} more files",
      "writeback.back": "Back to fork",
      "writeback.toggle": "Show what the fork settled",
      ...timelineMessages.en,
    },
    zh: {
      "fork.title": "从这里分叉：新会话带上到这条消息为止的历史",
      "fork.failed": "分叉失败",
      "panel.openTab": "在标签页打开",
      "panel.stop": "停止",
      "panel.running": "生成中…",
      "panel.input": "消息（Enter 发送，Shift+Enter 换行）",
      "panel.send": "发送",
      "panel.quote": "引用",
      "panel.quote.remove": "移除引用",
      "panel.send.failed": "发送失败",
      "panel.permission": "分叉会话在等待授权，请在标签页中打开处理。",
      "panel.loading": "加载中…",
      "panel.empty": "这个分叉还没有消息，可以在下方输入。",
      "writeback.from": "来自 Fork · {{name}}",
      "writeback.confirm.title": "并入主线？",
      "writeback.confirm.yes": "并入",
      "writeback.confirm.no": "不并入",
      "writeback.conclusion": "结论：",
      "writeback.changes": "改动：",
      "writeback.open": "还悬着：",
      "writeback.none": "无",
      "writeback.separator": "：",
      "writeback.more.other": "另有 {{count}} 个文件",
      "writeback.back": "回到 Fork",
      "writeback.toggle": "查看这个分叉定下的事",
      ...timelineMessages.zh,
    },
  },

  setup(ctx) {
    ctx.add(Style, css)

    // Drafts live in window memory, which outlasts a plugin reload; the fork session itself is on the server. A draft is
    // two parts: what the user types, and the quote the fork started from. `quote` is optional: a window that ran the
    // previous version holds drafts without it.
    const [drafts, setDrafts] = ctx.storage.memory<{ text: Record<string, string>; quote?: Record<string, string> }>(
      "drafts",
      { initial: { text: {}, quote: {} } },
    )
    const draft = (forkID: string) => ({
      text: () => drafts.text[forkID] ?? "",
      setText: (value: string) =>
        setDrafts((store) => {
          store.text[forkID] = value
        }),
      quote: () => drafts.quote?.[forkID] || undefined,
      setQuote: (value: string | undefined) =>
        setDrafts((store) => {
          store.quote ??= {}
          if (value) store.quote[forkID] = value
          else delete store.quote[forkID]
        }),
    })
    const dropDraft = (forkID: string) =>
      setDrafts((store) => {
        delete store.text[forkID]
        delete store.quote?.[forkID]
      })
    const pendingFocus = new Set<string>()
    const inputs = new Map<string, HTMLTextAreaElement>()
    const focusInput = (forkID: string) => {
      const input = inputs.get(forkID)
      if (!input) return false
      input.focus()
      input.setSelectionRange(input.value.length, input.value.length)
      return true
    }

    // ---- Selection → candidate ------------------------------------------------------------------------------

    const partOf = (node: Node | null) =>
      (node instanceof Element ? node : node?.parentElement)?.closest<HTMLElement>("[data-timeline-part-id]") ?? undefined

    const candidate = (): Candidate | undefined => {
      const session = ctx.sessions.current()
      const selection = window.getSelection()
      if (!session || !selection || selection.isCollapsed || selection.rangeCount === 0) return
      const text = draftText(selection.toString())
      if (!text) return
      const range = selection.getRangeAt(0)
      const start = partOf(range.startContainer)
      const end = partOf(range.endContainer)
      if (!start || !end || start.closest(`[${OWN}]`)) return
      const a = parsePartId(start.dataset.timelinePartId)
      const b = parsePartId(end.dataset.timelinePartId)
      if (!a || !b || a.messageID !== b.messageID) return
      // User text shares the part id shape; only assistant messages fork.
      const message = session.server.data.session.message.get(session.id, a.messageID)
      if (message?.type !== "assistant") return
      const rect = range.getBoundingClientRect()
      if (!rect.width && !rect.height) return
      return { session, messageID: a.messageID, text, rect }
    }

    // ---- Fork -----------------------------------------------------------------------------------------------

    let forking = false
    const fork = async (target: Candidate) => {
      if (forking) return
      forking = true
      const { session } = target
      const client = session.server.client
      try {
        // Cut right after the selected message: page newest-first until it shows up.
        let before: string | undefined
        let newer: string | undefined
        let cursor: string | undefined
        for (;;) {
          const page = await client.message.list({ sessionID: session.id, order: "desc", limit: 100, cursor })
          const result = boundaryIn(page.data, target.messageID, newer)
          if (result.found) {
            before = result.before
            break
          }
          newer = result.newer
          cursor = page.cursor.next ?? undefined
          if (!cursor) throw new Error(`message ${target.messageID} not found`)
        }
        const original = await client.session.get({ sessionID: session.id })
        const created = await client.session.fork(before ? { sessionID: session.id, before } : { sessionID: session.id })
        // Title first: a session with a title gets none generated, which would be a model call.
        await client.session.update({ sessionID: created.id, title: forkTitle(original.title) })
        // The selection becomes the quote above an empty input, as quoting does in the host composer.
        const next = draft(created.id)
        next.setText("")
        next.setQuote(target.text)
        pendingFocus.add(created.id)
        window.getSelection()?.removeAllRanges()
        hide()
        // `select`, not `open`: an `open` reuses the preview slot, which would close the previous fork's tab.
        ctx.layout.open(`${ctx.id}:${TAB_PREFIX}${created.id}`, session, { tab: "select" })
      } catch (error) {
        console.error("[session-fork]", error)
        ctx.toast.show({ variant: "error", title: ctx.t("fork.failed"), description: String(error) })
      } finally {
        forking = false
      }
    }

    // ---- Fork button: inside the host toolbar, else a floating bar of our own ---------------------------------

    let current: Candidate | undefined
    const makeButton = () => {
      const button = (
        <button type="button" class="session-fork-button" {...{ [OWN]: "" }} title={ctx.t("fork.title")}>
          <ctx.ui.Icon name="fork" size="small" />
          <span>{ctx.t("fork")}</span>
        </button>
      ) as HTMLButtonElement
      // Keeps the selection alive through the click, as the host toolbar does.
      button.addEventListener("mousedown", (event) => event.preventDefault())
      button.addEventListener("click", (event) => {
        event.preventDefault()
        event.stopPropagation()
        const target = candidate() ?? current
        if (target) void fork(target)
      })
      return button
    }
    const inline = makeButton()
    const floating = (
      <div class="session-fork-floating" role="toolbar" {...{ [OWN]: "" }} hidden>
        {makeButton()}
      </div>
    ) as HTMLDivElement
    document.body.append(floating)
    onCleanup(() => {
      inline.remove()
      floating.remove()
    })

    const hide = () => {
      current = undefined
      inline.remove()
      floating.hidden = true
    }
    const place = () => {
      const host = document.querySelector(HOST_TOOLBAR)
      if (host) {
        floating.hidden = true
        if (inline.parentElement !== host) host.append(inline)
        return
      }
      inline.remove()
      if (!current) return
      floating.hidden = false
      const { rect } = current
      const width = floating.offsetWidth || 80
      const height = floating.offsetHeight || 32
      const below = rect.bottom + 8 + height <= window.innerHeight
      const top = below ? rect.bottom + 8 : Math.max(8, rect.top - height - 8)
      const left = Math.min(Math.max(8, rect.right - width), window.innerWidth - width - 8)
      floating.style.top = `${top}px`
      floating.style.left = `${left}px`
    }

    // The host shows its toolbar 150ms after the selection settles, then measures it; give it well over that before
    // the floating bar steps in.
    let settle: ReturnType<typeof setTimeout> | undefined
    // A selection being dragged is not settled yet: nothing shows until the button comes up.
    let dragging = false
    const refresh = () => {
      clearTimeout(settle)
      if (dragging) return hide()
      const next = candidate()
      if (!next) return hide()
      current = next
      if (document.querySelector(HOST_TOOLBAR)) return place()
      settle = setTimeout(() => {
        current = candidate() ?? undefined
        if (current) place()
        else hide()
      }, 400)
    }
    document.addEventListener("selectionchange", refresh)
    // Presses on our button or the host toolbar keep the selection, so they do not start a drag.
    const onPress = (event: MouseEvent) => {
      if (event.button !== 0) return
      const target = event.target instanceof Element ? event.target : null
      if (target?.closest(`[${OWN}], ${HOST_TOOLBAR}`)) return
      dragging = true
      clearTimeout(settle)
      hide()
    }
    const onRelease = () => {
      if (!dragging) return
      dragging = false
      refresh()
    }
    document.addEventListener("mousedown", onPress, true)
    window.addEventListener("mouseup", onRelease, true)
    // A release outside the window never arrives; leaving the window ends the drag instead.
    window.addEventListener("blur", onRelease)
    onCleanup(() => {
      clearTimeout(settle)
      document.removeEventListener("selectionchange", refresh)
      document.removeEventListener("mousedown", onPress, true)
      window.removeEventListener("mouseup", onRelease, true)
      window.removeEventListener("blur", onRelease)
    })

    // The host toolbar mounts and unmounts as the selection changes; join it whenever it appears.
    let frame: number | undefined
    const observer = new MutationObserver(() => {
      if (frame !== undefined || !current) return
      frame = requestAnimationFrame(() => {
        frame = undefined
        if (current) place()
      })
    })
    observer.observe(document.body, { childList: true, subtree: true })
    onCleanup(() => {
      observer.disconnect()
      if (frame !== undefined) cancelAnimationFrame(frame)
    })
    const onScroll = () => current && !document.querySelector(HOST_TOOLBAR) && refresh()
    document.addEventListener("scroll", onScroll, { capture: true, passive: true })
    onCleanup(() => document.removeEventListener("scroll", onScroll, { capture: true }))

    // ---- Side panel: the fork beside the original ----------------------------------------------------------

    const tabs = new Map<string, { id: string; title: string }>()
    const tabFor = (id: string) => {
      let tab = tabs.get(id)
      if (!tab) tabs.set(id, (tab = { id, title: ctx.t("panel.title") }))
      return tab
    }

    const timeline = createTimeline(ctx)

    // At most six lines tall, then the input scrolls; the measures match `.session-fork-input` in the CSS.
    const LINE = 20
    const PAD = 10
    const MAX_LINES = 6
    const fit = (input: HTMLTextAreaElement) => {
      input.style.height = "auto"
      const height = Math.min(input.scrollHeight, LINE * MAX_LINES + PAD)
      input.style.height = `${Math.max(height, LINE + PAD)}px`
      input.style.overflowY = input.scrollHeight > LINE * MAX_LINES + PAD ? "auto" : "hidden"
    }

    function ForkView(props: PanelProps) {
      // Read once: a render belongs to one tab, and once the host drops the tab `props.tab` throws, which would abort
      // the host's close from inside our memos and cleanups.
      const id = untrack(() => props.tab.id.slice(TAB_PREFIX.length))
      const forkID = () => id
      const server = () => props.session.server
      const data = () => server().data
      const current = draft(forkID())
      const [sending, setSending] = createSignal(false)
      // Tells "still loading" from "the fork has no messages" once the first message sync settles.
      const [loaded, setLoaded] = createSignal(false)
      // Rows open as the user leaves them while the panel stays mounted; a new mount starts with every row folded.
      const [opened, setOpened] = createStore<Record<string, boolean>>({})
      const disclosure: Disclosures = {
        open: (key) => opened[key] === true,
        set: (key, open) => setOpened(key, open),
      }

      // The host keeps messages only for sessions in shell tabs plus the last few viewed (`createSessionRetention`,
      // limit 3), and evicts the rest whenever its session list changes: a fork that lives only in this panel lost its
      // messages, and the stream into them, on the first update after a send. The transcript lives in a Data of our own
      // on the host's event stream instead, which no retention touches; a new server controller gets a new one.
      const transcript = createMemo(() => {
        const host = data()
        return untrack(() =>
          createData({
            api: () => server().client,
            directory: "",
            event: { on: host.on, listen: host.listen },
            connection: { status: () => (server().connected ? "connected" : "reconnecting") },
            omitToolFileData: true,
          }),
        )
      })
      createEffect(() => {
        if (!server().connected) return
        const own = transcript()
        untrack(() => {
          void own.session.message
            .sync(forkID())
            .then(() => {
              if (own.session.message.more(forkID())) return own.session.message.loadMore(forkID(), { all: true })
            })
            .catch(() => {})
            .finally(() => setLoaded(true))
        })
      })
      onMount(() => {
        void data().session.sync(forkID()).catch(() => {})
        void data().session.permission.sync(forkID()).catch(() => {})
      })

      const info = createMemo(() => data().session.list().find((session) => session.id === forkID()))
      const messages = createMemo(() =>
        // Copies keep their original times; ids break ties (copies end in a numeric `_<n>`).
        [...transcript().session.message.list(forkID())].sort(
          (a, b) => (a.time?.created ?? 0) - (b.time?.created ?? 0) || compareMessageIds(a.id, b.id),
        ),
      )
      const running = () => data().session.status(forkID()) === "running"
      // The host (2.3.0) returns undefined here until permission.sync lands, although its type says an array.
      const permissions = () => data().session.permission.list(forkID()) ?? []
      // Where the fork works, so rows name folders inside the project by their relative path.
      const root = () => props.session.location?.directory

      // The assistant messages of one turn read as one stream, so a stretch of calls folds across steps, as in the host.
      // The part the model writes now: the last part of the running turn's last message, as in the host. A thought
      // anywhere else is finished, also one a stop or this fork cut off before it ended.
      const live = createMemo(() => {
        const last = messages().at(-1)
        if (!running() || last?.type !== "assistant" || !last.content.length) return
        return partKeys(last.id, last.content as TurnPart[]).at(-1)
      })
      const entries = createMemo(() => {
        const list: Entry[] = []
        let turn: { key: string; part: TurnPart }[] = []
        const flush = () => {
          for (const row of foldTurn(turn, live())) list.push({ kind: "row", key: row.key, row })
          turn = []
        }
        for (const message of messages()) {
          if (message.type === "assistant") {
            const parts = message.content as TurnPart[]
            const keys = partKeys(message.id, parts)
            parts.forEach((part, index) => turn.push({ key: keys[index]!, part }))
            continue
          }
          // Only what the user sent ends a turn; notices the server adds between steps (the fork notice among them) do not.
          if (message.type === "user") {
            flush()
            list.push({ kind: "user", key: `user:${message.id}`, message })
          } else if (message.type === "shell") {
            flush()
            list.push({ kind: "shell", key: `shell:${message.id}`, message })
          }
        }
        flush()
        return list
      })
      // Rows are keyed by string, so a row stays mounted, with its open state and rendered Markdown, while history grows.
      const keys = createMemo(() => entries().map((entry) => entry.key), [], {
        equals: (a, b) => a.length === b.length && a.every((key, index) => key === b[index]),
      })
      const byKey = createMemo(() => new Map(entries().map((entry) => [entry.key, entry])))

      const openTab = () => ctx.tabs.open({ server: server().id, id: forkID() }, { focus: true })
      const stop = () => void server().client.session.interrupt({ sessionID: forkID() }).catch(() => {})
      let input: HTMLTextAreaElement | undefined
      const canSend = () => !!current.text().trim() || !!current.quote()
      const send = async () => {
        if (!canSend() || sending()) return
        setSending(true)
        // What goes out; anything typed while the request is in flight is the next message, and stays.
        const sent = { text: current.text(), quote: current.quote() }
        try {
          // The text the model reads and the metadata the timeline reads, as the host composer sends a quote.
          const prompt = composePrompt(sent.text, sent.quote)
          // Through our Data, so the message shows at once and the reply streams into the same store.
          await transcript().session.prompt({ sessionID: forkID(), ...prompt })
          if (current.quote() === sent.quote) current.setQuote(undefined)
          if (current.text() === sent.text) {
            current.setText("")
            if (input) {
              input.value = ""
              refit(input)
            }
          }
        } catch (error) {
          ctx.toast.show({ variant: "error", title: ctx.t("panel.send.failed"), description: String(error) })
        } finally {
          setSending(false)
        }
      }

      let list: HTMLDivElement | undefined
      const follow = () => list && (list.scrollTop = list.scrollHeight)
      // A streaming reply grows in place; keep it in view unless the reader has scrolled up.
      let pinned = true
      const onScroll = () => list && (pinned = list.scrollHeight - list.scrollTop - list.clientHeight < 48)
      createEffect(() => {
        const last = messages().at(-1)
        if (last?.type === "assistant")
          for (const part of last.content) void (part.type === "tool" ? part.state.status : part.text.length)
        if (pinned) requestAnimationFrame(follow)
      })
      const onRender = () => pinned && follow()
      // The list shrinks as the input grows or a quote comes and goes; a reader at the bottom stays at the bottom.
      const refit = (element: HTMLTextAreaElement) => {
        fit(element)
        if (pinned) requestAnimationFrame(follow)
      }

      return (
        <div class="session-fork-panel" {...{ [OWN]: "" }}>
          <div class="session-fork-header">
            <ctx.ui.Icon name="fork" size="small" />
            <span class="session-fork-heading" title={info()?.title}>
              {info()?.title ?? ctx.t("panel.title")}
            </span>
            <ctx.ui.Button size="small" variant="ghost" onClick={openTab}>
              {ctx.t("panel.openTab")}
            </ctx.ui.Button>
          </div>
          <div class="session-fork-messages" ref={(element) => (list = element)} onScroll={onScroll}>
            <Show
              when={keys().length > 0}
              fallback={<div class="session-fork-muted">{ctx.t(loaded() ? "panel.empty" : "panel.loading")}</div>}
            >
              <For each={keys()}>
                {(key) => (
                  <Show when={byKey().get(key)}>
                    {(entry) => (
                      <EntryView
                        entry={entry()}
                        live={live()}
                        disclosure={disclosure}
                        root={root()}
                        onRender={onRender}
                      />
                    )}
                  </Show>
                )}
              </For>
            </Show>
            <Show when={running()}>
              <div class="session-fork-muted">{ctx.t("panel.running")}</div>
            </Show>
          </div>
          <Show when={permissions().length > 0}>
            <div class="session-fork-permission">
              <span>{ctx.t("panel.permission")}</span>
              <ctx.ui.Button size="small" variant="contrast" onClick={openTab}>
                {ctx.t("panel.openTab")}
              </ctx.ui.Button>
            </div>
          </Show>
          <div class="session-fork-composer">
            <Show when={current.quote()}>
              {(quote) => (
                <QuoteCard
                  text={quote()}
                  onRemove={() => {
                    current.setQuote(undefined)
                    input?.focus()
                    if (pinned) requestAnimationFrame(follow)
                  }}
                />
              )}
            </Show>
            <div class="session-fork-input">
              <textarea
                ref={(element) => {
                  input = element
                  inputs.set(forkID(), element)
                  // The draft is in place before the first frame, so the caret can land at its end.
                  element.value = current.text()
                  onCleanup(() => inputs.get(forkID()) === element && inputs.delete(forkID()))
                  // Sized once it is laid out, then the caret lands right after a fork.
                  requestAnimationFrame(() => {
                    fit(element)
                    if (pendingFocus.delete(forkID())) focusInput(forkID())
                  })
                  // A width change rewraps the text: a panel resized, or mounted while hidden and shown later.
                  let width = 0
                  const observer = new ResizeObserver(() => {
                    if (element.clientWidth === width) return
                    width = element.clientWidth
                    refit(element)
                  })
                  observer.observe(element)
                  onCleanup(() => observer.disconnect())
                }}
                value={current.text()}
                aria-label={ctx.t("panel.input")}
                rows={1}
                onInput={(event) => {
                  current.setText(event.currentTarget.value)
                  refit(event.currentTarget)
                }}
                onKeyDown={(event) => {
                  if (event.key !== "Enter" || event.shiftKey || event.isComposing) return
                  event.preventDefault()
                  void send()
                }}
              />
              <Show
                when={running()}
                fallback={
                  <ctx.ui.IconButton
                    icon="arrow-up"
                    label={ctx.t("panel.send")}
                    size="small"
                    variant="ghost"
                    class="session-fork-send"
                    disabled={!canSend()}
                    busy={sending()}
                    onClick={() => void send()}
                  />
                }
              >
                <ctx.ui.IconButton
                  icon="stop"
                  label={ctx.t("panel.stop")}
                  size="small"
                  variant="ghost"
                  class="session-fork-send"
                  onClick={stop}
                />
              </Show>
            </div>
          </div>
        </div>
      )
    }

    type Entry =
      | { kind: "user"; key: string; message: Extract<SessionMessageInfo, { type: "user" }> }
      | { kind: "shell"; key: string; message: Extract<SessionMessageInfo, { type: "shell" }> }
      | { kind: "row"; key: string; row: TurnRow<TurnPart> }

    function EntryView(props: {
      entry: Entry
      live?: string
      disclosure: Disclosures
      root?: string
      onRender: () => void
    }) {
      onMount(() => props.onRender())
      return (
        <Switch>
          <Match when={props.entry.kind === "user" && props.entry}>
            {(entry) => {
              const shown = createMemo(() => readPresentation(entry().message.text, entry().message.metadata))
              return (
                <div class="session-fork-user">
                  <For each={shown().quotes}>{(quote) => <QuoteCard text={quote} />}</For>
                  <Show when={shown().body.trim()}>
                    <div class="session-fork-user-text">{shown().body}</div>
                  </Show>
                </div>
              )
            }}
          </Match>
          <Match when={props.entry.kind === "shell" && props.entry}>
            {(entry) => (
              <timeline.ShellCard
                command={entry().message.command}
                output={entry().message.output?.output}
                status={entry().message.status}
                exit={entry().message.exit}
              />
            )}
          </Match>
          <Match when={props.entry.kind === "row" && props.entry}>
            {(entry) => (
              <div class="session-fork-assistant">
                <timeline.TurnRowView
                  row={entry().row}
                  live={props.live}
                  disclosure={props.disclosure}
                  root={props.root}
                />
              </div>
            )}
          </Match>
        </Switch>
      )
    }

    /**
     * A quote, as the composer holds it and as a sent message shows it: three lines at most, the whole quote on a click.
     * With `onRemove` it has a × that drops it from the draft.
     */
    function QuoteCard(props: { text: string; onRemove?: () => void }) {
      const [expanded, setExpanded] = createSignal(false)
      // Not a <button>: line clamping needs a block box, and the text stays selectable.
      return (
        <div class="session-fork-quote" data-expanded={expanded() ? "" : undefined}>
          <div
            role="button"
            tabIndex={0}
            class="session-fork-quote-text"
            aria-expanded={expanded()}
            onClick={() => {
              // A click that ends a text selection inside the quote selects, not toggles.
              if (window.getSelection()?.isCollapsed === false) return
              setExpanded(!expanded())
            }}
            onKeyDown={(event) => {
              if (event.key !== "Enter" && event.key !== " ") return
              event.preventDefault()
              setExpanded(!expanded())
            }}
          >
            {props.text}
          </div>
          <Show when={props.onRemove}>
            {(remove) => (
              <ctx.ui.IconButton
                icon="close-small"
                label={ctx.t("panel.quote.remove")}
                size="small"
                variant="ghost-muted"
                class="session-fork-quote-remove"
                onClick={() => remove()()}
              />
            )}
          </Show>
        </div>
      )
    }

    // ---- Write-back: what a closed fork settled returns to its main session as one notice -----------------------

    const config = writebackConfig(ctx.options)
    // Dialogs close with the owner that asked; a closing tab's owner is going away, the plugin's stays.
    const root = getOwner()
    const writing = new Set<string>()
    const labels = (): SummaryLabels => ({
      conclusion: ctx.t("writeback.conclusion"),
      changes: ctx.t("writeback.changes"),
      open: ctx.t("writeback.open"),
      none: ctx.t("writeback.none"),
      separator: ctx.t("writeback.separator"),
      more: (count) => ctx.plural("writeback.more", count),
    })

    type Client = MountedSession["server"]["client"]
    /** A session's messages created at `since` or later, oldest first: pages newest first until older ones show. */
    const newerThan = async (client: Client, sessionID: string, since: number) => {
      const found: SessionMessageInfo[] = []
      let cursor: string | undefined
      for (;;) {
        const page = await client.message.list({ sessionID, order: "desc", limit: 100, cursor })
        for (const message of page.data) if ((message.time?.created ?? 0) >= since) found.push(message)
        cursor = page.cursor.next ?? undefined
        if (!cursor || page.data.some((message) => (message.time?.created ?? 0) < since)) break
      }
      return found.reverse()
    }

    /** Runs after the tab is gone: nothing here can hold the close up, and every failure ends in one log line. */
    const writeBack = (forkID: string, session: MountedSession) => {
      if (writing.has(forkID)) return
      writing.add(forkID)
      const client = session.server.client
      const directory = session.directory ?? session.location?.directory
      void runWriteback({
        config,
        forkID,
        labels: labels(),
        description: (name) => ctx.t("writeback.from", { name }),
        load: async () => {
          const info = await client.session.get({ sessionID: forkID })
          const messages = await newerThan(client, forkID, info.time.created)
          return {
            title: info.title,
            created: info.time.created,
            mainID: info.fork?.sessionID,
            root: directory,
            metadata: info.metadata,
            messages: messages as unknown as ForkMessage[],
          }
        },
        existing: async (mainID, since) => {
          const [inbox, messages] = await Promise.all([
            client.session.inbox.list({ sessionID: mainID }),
            newerThan(client, mainID, since),
          ])
          return [
            ...inbox.flatMap((item) => (item.type === "synthetic" ? [item.payload.metadata] : [])),
            ...messages.flatMap((message) => (message.type === "synthetic" ? [message.metadata] : [])),
          ].some((metadata) => writebackMeta(metadata)?.forkID === forkID)
        },
        generate: (prompt, model, signal) =>
          client.experimental.generate
            .text(
              { prompt, model },
              // The session's own directory, named on the request: the server resolves the model in the location the
              // request names, and a request without one boots a location of its own where the model may not exist yet.
              { signal, ...(directory ? { headers: { "x-opencode-directory": encodeURIComponent(directory) } } : {}) },
            )
            .then((result) => result.text)
            .catch((error) => {
              // Once per failed attempt, not per run: which model was asked for, and in which directory.
              const detail =
                `[session-fork] generate failed: model=${JSON.stringify(model)} dir=${directory ?? "(unknown)"}` +
                ` ref=${model.providerID}/${model.id}${model.variant ? `#${model.variant}` : ""}: ${
                  error instanceof Error ? error.message : String(error)
                }`
              console.error(detail)
              throw error
            }),
        confirm: (preview) =>
          runWithOwner(root, () =>
            ctx.dialogs.confirm({
              title: ctx.t("writeback.confirm.title"),
              description: `${ctx.t("writeback.from", { name: preview.title })}\n\n${preview.body}`,
              confirm: ctx.t("writeback.confirm.yes"),
              cancel: ctx.t("writeback.confirm.no"),
            }),
          ) ?? Promise.resolve(false),
        // `resume: false`, as the host's own background notices: the notice waits for the main session's next turn
        // instead of starting one, so writing back never runs its model.
        write: (input) =>
          client.session
            .synthetic({
              sessionID: input.mainID,
              text: input.text,
              description: input.description,
              metadata: input.metadata as unknown as Record<string, never>,
              resume: false,
            })
            .then(() => undefined),
        remember: (state, metadata) =>
          client.session.update({
            sessionID: forkID,
            metadata: { ...(metadata as Record<string, never> | undefined), [STATE_KEY]: state as Record<string, never> },
          }),
        log: (line) => console.info(line),
      }).finally(() => writing.delete(forkID))
    }

    // The host shows a notice as one line of its description and nothing more. Ours open in place to what the fork
    // settled, with a way back to the fork; the host's line itself stays as the host drew it.
    type Writeback = { id: string; description: string; meta: WritebackMeta }
    const writebacks = createMemo((): Writeback[] => {
      const session = ctx.sessions.current()
      if (!session) return []
      const data = session.server.data.session
      const seen = new Set<string>()
      const list: Writeback[] = []
      const add = (id: string, description: string | undefined, metadata: unknown) => {
        const meta = writebackMeta(metadata)
        if (!meta || seen.has(id)) return
        seen.add(id)
        list.push({ id, description: description?.trim() ?? "", meta })
      }
      for (const message of data.message.list(session.id))
        if (message.type === "synthetic") add(message.id, message.description, message.metadata)
      // One still waiting for the main session's next turn shows after the delivered ones, as the host orders them.
      for (const item of data.pending.list(session.id) ?? [])
        if (item.type === "synthetic") add(item.id, item.payload.description, item.payload.metadata)
      return list
    })

    const NOTICE = "[data-slot=session-timeline-notice]"
    const MARK = "data-session-fork-writeback"
    const expanded = new Set<string>()
    const decorations = new Map<HTMLElement, { details: HTMLElement; dispose: () => void; set: (item: Writeback) => void }>()
    const undecorate = (element: HTMLElement) => {
      const decoration = decorations.get(element)
      if (!decoration) return
      decoration.details.remove()
      decoration.dispose()
      decorations.delete(element)
    }
    const attach = (element: HTMLElement, first: Writeback) =>
      createRoot((dispose) => {
        const [item, setItem] = createSignal(first)
        const [open, setOpen] = createSignal(expanded.has(first.id))
        const toggle = () => {
          const next = !open()
          setOpen(next)
          if (next) expanded.add(item().id)
          else expanded.delete(item().id)
        }
        const onClick = (event: MouseEvent) => {
          // A click that ends a text selection selects, not toggles.
          if (window.getSelection()?.isCollapsed === false) return
          event.preventDefault()
          toggle()
        }
        const onKey = (event: KeyboardEvent) => {
          if (event.key !== "Enter" && event.key !== " ") return
          event.preventDefault()
          toggle()
        }
        element.setAttribute(MARK, "")
        element.setAttribute("role", "button")
        element.tabIndex = 0
        element.title = ctx.t("writeback.toggle")
        createEffect(() => element.setAttribute("aria-expanded", String(open())))
        element.addEventListener("click", onClick)
        element.addEventListener("keydown", onKey)
        const details = (
          <WritebackCard item={item()} open={open()} onBack={() => backToFork(item().meta.forkID)} />
        ) as HTMLElement
        element.after(details)
        onCleanup(() => {
          element.removeEventListener("click", onClick)
          element.removeEventListener("keydown", onKey)
          for (const name of [MARK, "role", "tabindex", "title", "aria-expanded"]) element.removeAttribute(name)
        })
        return {
          details,
          dispose,
          set: (next: Writeback) => {
            if (next.id === item().id) return
            setItem(next)
            setOpen(expanded.has(next.id))
          },
        }
      })
    const decorate = () => {
      for (const element of [...decorations.keys()]) if (!element.isConnected) undecorate(element)
      const list = writebacks()
      // The same header twice (two forks of one title) pairs up in order, as the host lists them.
      const queues = new Map<string, Writeback[]>()
      for (const item of list) queues.set(item.description, [...(queues.get(item.description) ?? []), item])
      const used = new Map<string, number>()
      for (const element of document.querySelectorAll<HTMLElement>(NOTICE)) {
        if (element.closest(`[${OWN}]`)) continue
        const label = (element.querySelector("bdi")?.textContent ?? element.textContent ?? "").trim()
        const index = used.get(label) ?? 0
        const item = queues.get(label)?.[index]
        if (!item) {
          undecorate(element)
          continue
        }
        used.set(label, index + 1)
        const decoration = decorations.get(element)
        if (decoration) decoration.set(item)
        else decorations.set(element, attach(element, item))
      }
    }
    let decorating: number | undefined
    const schedule = () => {
      if (decorating !== undefined || (!writebacks().length && !decorations.size)) return
      decorating = requestAnimationFrame(() => {
        decorating = undefined
        decorate()
      })
    }
    createEffect(() => {
      writebacks()
      schedule()
    })
    const notices = new MutationObserver(schedule)
    notices.observe(document.body, { childList: true, subtree: true })
    onCleanup(() => {
      notices.disconnect()
      if (decorating !== undefined) cancelAnimationFrame(decorating)
      for (const element of [...decorations.keys()]) undecorate(element)
    })

    const backToFork = (forkID: string) => {
      const session = ctx.sessions.current()
      if (session) ctx.layout.open(`${ctx.id}:${TAB_PREFIX}${forkID}`, session, { tab: "select" })
    }

    /** What a write-back notice opens to: the three sections and the way back to its fork. */
    function WritebackCard(props: { item: Writeback; open: boolean; onBack: () => void }) {
      const meta = () => props.item.meta
      const files = () => [
        ...meta().files.map((file) => (file.note ? `${file.path}${ctx.t("writeback.separator")}${file.note}` : file.path)),
        ...(meta().more ? [ctx.plural("writeback.more", meta().more)] : []),
      ]
      const section = (title: string, items: string[]) => (
        <div class="session-fork-writeback-section">
          <div class="session-fork-writeback-heading">{title}</div>
          <Show when={items.length} fallback={<div class="session-fork-writeback-item">{ctx.t("writeback.none")}</div>}>
            <For each={items}>{(item) => <div class="session-fork-writeback-item">{item}</div>}</For>
          </Show>
        </div>
      )
      return (
        <div class="session-fork-writeback" data-open={props.open ? "" : undefined} {...{ [OWN]: "" }}>
          <div class="session-fork-writeback-clip">
            <div class="session-fork-writeback-body">
              {section(ctx.t("writeback.conclusion").replace(/[：:]\s*$/, ""), meta().conclusion ? [meta().conclusion] : [])}
              {section(ctx.t("writeback.changes").replace(/[：:]\s*$/, ""), files())}
              {section(ctx.t("writeback.open").replace(/[：:]\s*$/, ""), [...meta().open])}
              <div class="session-fork-writeback-actions">
                <ctx.ui.Button size="small" variant="ghost" onClick={() => props.onBack()}>
                  <ctx.ui.Icon name="fork" size="small" />
                  {ctx.t("writeback.back")}
                </ctx.ui.Button>
              </div>
            </div>
          </div>
        </div>
      )
    }

    ctx.add(Panel, {
      id: PANEL,
      region: "side",
      get width() {
        return Math.max(360, Math.round(window.innerWidth * 0.45))
      },
      list: (input) => input.open.filter((id) => id.startsWith(TAB_PREFIX)).map(tabFor),
      render: (props) => <ForkView {...props} />,
      // The fork session stays on the server; its unsent draft goes, and what it settled may go back to the main
      // session. Read the getters now: the tab is already gone, and the write-back runs on after this returns.
      close: (input) => {
        const forkID = input.tab.id.slice(TAB_PREFIX.length)
        dropDraft(forkID)
        writeBack(forkID, input.session)
      },
      focus: (input) => {
        if (!input.restored) requestAnimationFrame(() => focusInput(input.tab.id.slice(TAB_PREFIX.length)))
      },
      enter: (input) => {
        focusInput(input.tab.id.slice(TAB_PREFIX.length))
      },
    })
  },
})
