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
