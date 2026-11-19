import { Panel, Plugin, Style, type MountedSession, type PanelProps } from "@opencode/plugin/gui"
import type { SessionMessageInfo } from "@opencode/client/promise"
import { For, Match, Show, Switch, createMemo, createSignal, onCleanup, onMount, untrack } from "solid-js"
import { boundaryIn, compareMessageIds, draftText, forkTitle, parsePartId } from "./core.ts"
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
      "panel.close": "Close",
      "panel.stop": "Stop",
      "panel.running": "Generating…",
      "panel.placeholder": "Ask about the selection… (Enter to send, Shift+Enter for a new line)",
      "panel.send": "Send",
      "panel.permission": "This fork is waiting for a permission. Open it in a tab to answer.",
      "panel.loading": "Loading…",
      "panel.empty": "No messages in this fork yet. Send one below.",
      "panel.reasoning": "Thinking",
      "panel.tool": "Tool",
      "panel.shell": "Shell",
    },
    zh: {
      "fork.title": "从这里分叉：新会话带上到这条消息为止的历史",
      "fork.failed": "分叉失败",
      "panel.openTab": "在标签页打开",
      "panel.close": "关闭",
      "panel.stop": "停止",
      "panel.running": "生成中…",
      "panel.placeholder": "就所选内容追问…（Enter 发送，Shift+Enter 换行）",
      "panel.send": "发送",
      "panel.permission": "分叉会话在等待授权，请在标签页中打开处理。",
      "panel.loading": "加载中…",
      "panel.empty": "这个分叉还没有消息，可以在下方输入。",
      "panel.reasoning": "思考",
      "panel.tool": "工具",
      "panel.shell": "命令",
    },
  },

  setup(ctx) {
    ctx.add(Style, css)

    // Drafts live in window memory, which outlasts a plugin reload; the fork session itself is on the server.
    const [drafts, setDrafts] = ctx.storage.memory<{ text: Record<string, string> }>("drafts", { initial: { text: {} } })
    const draft = (forkID: string) =>
      [
        () => drafts.text[forkID] ?? "",
        (value: string) =>
          setDrafts((store) => {
            store.text[forkID] = value
          }),
      ] as const
    const dropDraft = (forkID: string) =>
      setDrafts((store) => {
        delete store.text[forkID]
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
        draft(created.id)[1](target.text)
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

    function ForkView(props: PanelProps) {
      // Read once: a render belongs to one tab, and once the host drops the tab `props.tab` throws, which would abort
      // the host's close from inside our memos and cleanups.
      const id = untrack(() => props.tab.id.slice(TAB_PREFIX.length))
      const forkID = () => id
      const key = `${ctx.id}:${TAB_PREFIX}${id}`
      const server = () => props.session.server
      const data = () => server().data
      const [text, setText] = draft(forkID())
      const [sending, setSending] = createSignal(false)
      // Tells "still loading" from "the fork has no messages" once the first message sync settles.
      const [loaded, setLoaded] = createSignal(false)

      onMount(() => {
        void data().session.sync(forkID()).catch(() => {})
        void data()
          .session.message.sync(forkID())
          .catch(() => {})
          .finally(() => setLoaded(true))
        void data().session.permission.sync(forkID()).catch(() => {})
      })

      const info = createMemo(() => data().session.list().find((session) => session.id === forkID()))
      const messages = createMemo(() =>
        // Copies keep their original times; ids break ties (copies end in a numeric `_<n>`).
        [...data().session.message.list(forkID())].sort(
          (a, b) => (a.time?.created ?? 0) - (b.time?.created ?? 0) || compareMessageIds(a.id, b.id),
        ),
      )
      const running = () => data().session.status(forkID()) === "running"
      // The host (2.3.0) returns undefined here until permission.sync lands, although its type says an array.
      const permissions = () => data().session.permission.list(forkID()) ?? []

      const openTab = () => ctx.tabs.open({ server: server().id, id: forkID() }, { focus: true })
      const close = () => ctx.layout.close(key, props.session)
      const stop = () => void server().client.session.interrupt({ sessionID: forkID() }).catch(() => {})
      const send = async () => {
        const value = text().trim()
        if (!value || sending()) return
        setSending(true)
        try {
          await data().session.prompt({ sessionID: forkID(), text: value })
          setText("")
        } catch (error) {
          ctx.toast.show({ variant: "error", title: ctx.t("fork.failed"), description: String(error) })
        } finally {
          setSending(false)
        }
      }

      let list: HTMLDivElement | undefined
      const follow = () => list && (list.scrollTop = list.scrollHeight)

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
            <ctx.ui.IconButton icon="close-small" label={ctx.t("panel.close")} onClick={close} />
          </div>
          <div class="session-fork-messages" ref={(element) => (list = element)}>
            <Show
              when={messages().length > 0}
              fallback={<div class="session-fork-muted">{ctx.t(loaded() ? "panel.empty" : "panel.loading")}</div>}
            >
              <For each={messages()}>{(message) => <Message message={message} onRender={follow} />}</For>
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
            <textarea
              ref={(element) => {
                inputs.set(forkID(), element)
                // The draft is in place before the first frame, so the caret can land at its end.
                element.value = text()
                onCleanup(() => inputs.get(forkID()) === element && inputs.delete(forkID()))
                // Lands the caret once the panel is on screen, right after a fork.
                requestAnimationFrame(() => pendingFocus.delete(forkID()) && focusInput(forkID()))
              }}
              value={text()}
              placeholder={ctx.t("panel.placeholder")}
              rows={4}
              onInput={(event) => setText(event.currentTarget.value)}
              onKeyDown={(event) => {
                if (event.key !== "Enter" || event.shiftKey || event.isComposing) return
                event.preventDefault()
                void send()
              }}
            />
            <div class="session-fork-actions">
              <Show
                when={running()}
                fallback={
                  <ctx.ui.Button size="small" variant="contrast" busy={sending()} onClick={() => void send()}>
                    {ctx.t("panel.send")}
                  </ctx.ui.Button>
                }
              >
                <ctx.ui.Button size="small" variant="neutral" onClick={stop}>
                  {ctx.t("panel.stop")}
                </ctx.ui.Button>
              </Show>
            </div>
          </div>
        </div>
      )
    }

    function Message(props: { message: SessionMessageInfo; onRender: () => void }) {
      onMount(() => props.onRender())
      return (
        <Switch>
          <Match when={props.message.type === "user" && props.message}>
            {(message) => <div class="session-fork-user">{message().text}</div>}
          </Match>
          <Match when={props.message.type === "shell" && props.message}>
            {(message) => (
              <div class="session-fork-muted">
                {ctx.t("panel.shell")}: {message().command}
              </div>
            )}
          </Match>
          <Match when={props.message.type === "assistant" && props.message}>
            {(message) => (
              <div class="session-fork-assistant">
                <For each={message().content}>
                  {(part) => (
                    <Switch>
                      <Match when={part.type === "text" && part}>
                        {(part) => <ctx.ui.Markdown text={part().text} />}
                      </Match>
                      <Match when={part.type === "reasoning" && part.text.trim() ? part : undefined}>
                        {(part) => (
                          <details class="session-fork-reasoning">
                            <summary>{ctx.t("panel.reasoning")}</summary>
                            <ctx.ui.Markdown text={part().text} />
                          </details>
                        )}
                      </Match>
                      <Match when={part.type === "tool" && part}>
                        {(part) => (
                          <div class="session-fork-muted">
                            {ctx.t("panel.tool")}: {part().name} · {part().state.status}
                          </div>
                        )}
                      </Match>
                    </Switch>
                  )}
                </For>
              </div>
            )}
          </Match>
        </Switch>
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
      // The fork session stays on the server; only its unsent draft goes.
      close: (input) => dropDraft(input.tab.id.slice(TAB_PREFIX.length)),
      focus: (input) => {
        if (!input.restored) requestAnimationFrame(() => focusInput(input.tab.id.slice(TAB_PREFIX.length)))
      },
      enter: (input) => {
        focusInput(input.tab.id.slice(TAB_PREFIX.length))
      },
    })
  },
})
