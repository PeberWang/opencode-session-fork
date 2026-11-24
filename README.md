# opencode-session-fork

An OpenCode Desktop GUI plugin: select text in an assistant reply, press **Fork**, and the selection (together with the conversation up to that message) becomes a new session, opened in the right-hand side panel. The highlighted text arrives as a quote card above the composer, the input stays empty — nothing is sent until you send it.

Built for the moment when a side question interrupts a main line of work: fork it off, settle it in the panel, close the panel, and what the fork settled comes back to the main thread as one short notice, if you agree, so the main thread never needs the context repeated.

## What it does

- **Selection toolbar**: Fork joins the host's own quote toolbar when it appears; if the host does not show one, a small floating bar of its own appears near the selection. It appears only once the selection settles, never while the mouse is still down.
- **Fork semantics**: new session titled `Fork · <first 20 chars of the original title>`, history copied up to the selected message, selected text as a removable quote card above the composer (it goes out ahead of your text, as the host's own quotes do), no automatic model call.
- **Side panel**: live transcript and composer on the right; tool calls fold into one-line activity rows you can expand, the same way the host's compact timeline folds them. `Open in the tab` hands over to the host's full session view.
- **Controlled write-back**: while the fork is open, the original session is not modified. When you close the fork's tab, the plugin summarises the fork and asks *Merge into the main thread?*; only if you say yes does one notice go into the original session. Closing always keeps the forked session on the server.

## Write-back

The notice reads **From Fork · <fork name>** in the original session's timeline, where the name is the fork's title without its repeated `Fork · ` prefix. Click it to open what the fork settled, in three sections and 300 characters at most:

1. **Conclusion**: what the fork finally decided, in two or three sentences.
2. **Changes**: the files the fork changed, one sentence each, up to 10 (then "N more files").
3. **Still open**: what was left undecided, up to three items.

The opened notice has **Back to fork**, which reopens the fork beside the session. The notice adds to the session; it never edits anything already in it. It is a synthetic message sent with `resume: false`, as the host's own background notices are: it does not start a turn or run the main session's model. The model reads it with the next message you send there.

- **Asked every time, written once**: the dialog shows the summary before anything is written. A fork is written back at most once, also across restarts: the fork's session metadata records it, and the plugin also looks for its own marker in the original session. If you decline, the plugin asks again only after the fork has new messages.
- **Nothing to report, nothing written**: a fork with no reply, or one that changed no files and concluded nothing (a question answered, say), writes nothing and asks nothing.
- **Never in the way**: the write-back runs after the tab has closed. If the summary model is unavailable, the network is down, or the call takes longer than the timeout, the plugin skips the write-back and logs one line, `[session-fork] writeback skipped (<fork id>): <reason>`, in the window's log (`renderer.log`).

### Configuration

The defaults need no configuration. To change them, give the plugin's entry options in `~/.config/opencode/opencode.jsonc` (the object form carries `options`; the bare path string loads the same plugin with the defaults). Saving the config reloads the plugin, no restart needed:

```jsonc
"plugins": [
  {
    "package": "/absolute/path/to/opencode-session-fork",
    "options": {
      "writeback": {
        "enabled": true,                           // write back at all
        "maxChars": 300,                           // the three sections together, in characters
        "confirm": true,                           // ask "Merge into the main thread?" first
        "model": "deepseek/deepseek-flash#none",   // provider/model#variant, through the server's own credentials
        "timeoutMs": 5000                          // one summary call; past it the write-back is skipped
      }
    }
  }
]
```

The default model runs without thinking (`#none`): with thinking, a summary of a long fork took over 20 seconds, past any reasonable timeout; without, about two.

## Install

```bash
git clone https://github.com/PeberWang/opencode-session-fork.git
cd opencode-session-fork
npm install && npm run build
```

Then add the checkout to the `plugins` array in `~/.config/opencode/opencode.jsonc`:

```jsonc
"plugins": ["/absolute/path/to/opencode-session-fork"]
```

OpenCode Desktop loads GUI parts from its own server, so adding the entry is enough: the config reload picks it up, and a rebuild reloads it in every window. If the app does not show it, open **Settings > Extensions > Plugins** and reload it, or quit and reopen (⌘Q). `opencode api get /api/plugin` should list `opencode-session-fork` as `active`.

## Design and verification

- `DESIGN_FORK.md` — where the feature hooks into the host, what the host API exposes, and what the fallbacks are.
- `ACCEPTANCE.md` — the real-machine acceptance items and their evidence.
- `HANDOFF.md` — install, rollback, and the host internals this plugin depends on.

## Known limits

- The panel is a simplified view: user messages, assistant text (host Markdown renderer, formulas and code included), collapsible reasoning, tool calls folded into the host's compact one-line activity rows with expandable details. No tool cards, no side-by-side diff viewer, no model or agent pickers, attachments, or slash commands. Use `Open in the tab` for those.
- Permission prompts are handled in the host, not in the panel; the panel points you to the tab.
- Drafts live in the window's memory: a restart keeps the forked session but not an unsent draft.
- Write-back happens when the fork's **tab is closed**. Quitting the app or hiding the side region with the tab still open writes nothing; the tab comes back next time, and closing it then asks.

## Dependencies on host internals

| Convention | Where (2.3.0) | Failure mode |
|---|---|---|
| Assistant part DOM: `[data-timeline-part-id="<msgID>:text:<n>"]` | `route-*.js`, `ks.contentEntries` | Fork button does not appear; host unaffected |
| Host quote toolbar: `[data-component=timeline-quote]` | `route-*.js`, `pk()` | Falls back to the plugin's own floating bar |
| Theme variables `--v2-*` | host CSS | Colours fall back to defaults |
| Notice row: `[data-slot=session-timeline-notice]`, its label in the first `<bdi>` | `session-ui` timeline `row.tsx` | The write-back still reaches the session and its model; the notice shows as the host's plain line, without the details or Back to fork |

Data layer uses only the official client (`message.list`, `session.get/fork/update/interrupt/synthetic/inbox.list`, `experimental.generate.text`, `server.data.session.*`); the view layer uses `Panel`, `ctx.ui.*`, `ctx.dialogs`, `ctx.layout`, and `ctx.tabs`.

## License

MIT
