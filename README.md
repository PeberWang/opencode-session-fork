# opencode-session-fork

An OpenCode Desktop GUI plugin: select text in an assistant reply, press **Fork**, and the selection (together with the conversation up to that message) becomes a new session, opened in the right-hand side panel. The highlighted text arrives as the composer draft — nothing is sent until you send it.

Built for the moment when a side question interrupts a main line of work: fork it off, settle it in the panel, close the panel, and the original thread is untouched.

## What it does

- **Selection toolbar**: Fork joins the host's own quote toolbar when it appears; if the host does not show one, a small floating bar of its own appears near the selection. It appears only once the selection settles, never while the mouse is still down.
- **Fork semantics**: new session titled `Fork · <first 20 chars of the original title>`, history copied up to the selected message, selected text as an editable draft, no automatic model call.
- **Side panel**: live transcript and composer on the right; `Open in the tab` hands over to the host's full session view.
- **No side effects**: the original session is not modified, and closing the panel keeps the forked session on the server.

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

Restart OpenCode Desktop (⌘Q and reopen) to load the GUI part. `opencode api get /api/plugin` should list `opencode-session-fork` as `active`.

## Design and verification

- `DESIGN_FORK.md` — where the feature hooks into the host, what the host API exposes, and what the fallbacks are.
- `ACCEPTANCE.md` — the real-machine acceptance items and their evidence.
- `HANDOFF.md` — install, rollback, and the host internals this plugin depends on.

## Known limits

- The panel is a simplified view: user messages, assistant text (host Markdown renderer, formulas and code included), collapsible reasoning, one-line tool summaries. No tool cards, diffs, model or agent pickers, attachments, or slash commands. Use `Open in the tab` for those.
- Permission prompts are handled in the host, not in the panel; the panel points you to the tab.
- Drafts live in the window's memory: a restart keeps the forked session but not an unsent draft.

## Dependencies on host internals

| Convention | Where (2.3.0) | Failure mode |
|---|---|---|
| Assistant part DOM: `[data-timeline-part-id="<msgID>:text:<n>"]` | `route-*.js`, `ks.contentEntries` | Fork button does not appear; host unaffected |
| Host quote toolbar: `[data-component=timeline-quote]` | `route-*.js`, `pk()` | Falls back to the plugin's own floating bar |
| Theme variables `--v2-*` | host CSS | Colours fall back to defaults |

Data layer uses only the official client (`message.list`, `session.get/fork/update/interrupt`, `server.data.session.*`); the view layer uses `Panel`, `ctx.ui.*`, `ctx.layout`, and `ctx.tabs`.

## License

MIT
