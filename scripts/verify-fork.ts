// Data-path acceptance: runs the plugin's fork sequence against the live server and checks the results.
// Same endpoints and parameters as src/gui.tsx `fork()`, through `opencode api` so it reuses the CLI's connection.
//
// Usage: node scripts/verify-fork.ts <sessionID> <assistantMessageID> [record-file]
// Creates one fork session and appends its id to record-file (default .research/verify/created_sessions.txt).

import { execFileSync } from "node:child_process"
import { appendFileSync } from "node:fs"
import { createHash } from "node:crypto"
import { boundaryIn, compareMessageIds, forkTitle } from "../src/core.ts"

type Message = { id: string; type: string; [key: string]: unknown }

const api = (method: "get" | "post" | "patch", path: string, body?: unknown): any => {
  const args = ["api", method, path, ...(body === undefined ? [] : ["-d", JSON.stringify(body)])]
  const out = execFileSync("opencode", args, { encoding: "utf8" })
  return out.trim() ? JSON.parse(out) : undefined
}
const op = (operation: string, params: Record<string, string>, body?: unknown): any => {
  const args = ["api", operation, ...Object.entries(params).flatMap(([k, v]) => ["--param", `${k}=${v}`])]
  if (body !== undefined) args.push("-d", JSON.stringify(body))
  const out = execFileSync("opencode", args, { encoding: "utf8" })
  return out.trim() ? JSON.parse(out) : undefined
}

const all = (sessionID: string): Message[] =>
  (api("get", `/api/session/${sessionID}/message`).data as Message[]).sort((a, b) => compareMessageIds(a.id, b.id))
// What a fork must reproduce: the conversation itself, not ids or timestamps.
const shape = (m: Message) => JSON.stringify({ ...m, id: undefined, time: undefined })
const hash = (value: unknown) => createHash("sha256").update(JSON.stringify(value)).digest("hex").slice(0, 16)
const snapshot = (sessionID: string) => {
  const info = api("get", `/api/session/${sessionID}`).data
  const messages = all(sessionID)
  return { title: info.title, time: info.time, count: messages.length, sha: hash(messages), messages }
}

const [sessionID, messageID, record = ".research/verify/created_sessions.txt"] = process.argv.slice(2)
if (!sessionID || !messageID) throw new Error("usage: verify-fork.ts <sessionID> <assistantMessageID>")

const before = snapshot(sessionID)

// 1. Boundary, as the plugin pages it: newest first, 100 at a time.
let cut: string | undefined
let newer: string | undefined
let cursor: string | undefined
for (;;) {
  const query = new URLSearchParams({ order: "desc", limit: "100", ...(cursor ? { cursor } : {}) })
  const page = api("get", `/api/session/${sessionID}/message?${query}`)
  const result = boundaryIn(page.data, messageID, newer)
  if (result.found) {
    cut = result.before
    break
  }
  newer = result.newer
  cursor = page.cursor?.next ?? undefined
  if (!cursor) throw new Error("message not found")
}

// 2. Fork, 3. title.
const created = op("session.fork", { sessionID }, cut ? { before: cut } : {}).data
appendFileSync(record, `${created.id}\n`)
op("session.update", { sessionID: created.id }, { title: forkTitle(before.title) })

// Checks.
const after = snapshot(sessionID)
const forked = snapshot(created.id)
const upto = before.messages.slice(0, before.messages.findIndex((m) => m.id === messageID) + 1)
// The fork copies every record up to and including the selected message (idle markers between turns too).
const expected = upto
const active = api("get", "/api/session/active").data
const inbox = api("get", `/api/session/${created.id}/inbox`).data as Message[]

const report = {
  original: sessionID,
  selectedMessage: messageID,
  before: cut ?? null,
  fork: created.id,
  originalCount: before.count,
  originalUpToSelected: upto.length,
  forkCount: forked.count,
  forkTypes: forked.messages.map((m) => m.type),
  forkContentMatches:
    forked.messages.length === expected.length && forked.messages.every((m, i) => shape(m) === shape(expected[i]!)),
  forkLastIsSelected: forked.messages.length > 0 && shape(forked.messages.at(-1)!) === shape(upto.at(-1)!),
  forkTitle: forked.title,
  forkRunning: active[created.id] ?? null,
  forkInbox: inbox.map((m) => ({ id: m.id, type: m.type })),
  forkHasUserMessageAfterHistory: forked.messages.slice(expected.length).some((m) => m.type === "user"),
  originalUnchanged:
    before.sha === after.sha && before.count === after.count && before.title === after.title &&
    JSON.stringify(before.time) === JSON.stringify(after.time),
  originalBefore: { count: before.count, sha: before.sha, title: before.title, time: before.time },
  originalAfter: { count: after.count, sha: after.sha, title: after.title, time: after.time },
}
console.log(JSON.stringify(report, null, 1))
