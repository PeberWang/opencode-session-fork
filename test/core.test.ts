import assert from "node:assert/strict"
import { test } from "node:test"
import {
  activityLabel,
  boundaryIn,
  compareMessageIds,
  composePrompt,
  diffBody,
  draftText,
  foldTurn,
  folder,
  forkTitle,
  parsePartId,
  partKeys,
  readPresentation,
  shellOutcome,
  stringDiff,
  toolFailed,
  toolInput,
  toolStopped,
  toolSummary,
  type ToolCall,
  type TurnPart,
} from "../src/core.ts"

test("parsePartId reads assistant text and reasoning parts", () => {
  assert.deepEqual(parsePartId("msg_1f4244cd90011wV0umwGEDBAeL:text:0"), {
    messageID: "msg_1f4244cd90011wV0umwGEDBAeL",
    type: "text",
    index: 0,
  })
  assert.equal(parsePartId("msg_abc_4:reasoning:2")?.messageID, "msg_abc_4")
  assert.equal(parsePartId("call_00_xyz"), undefined)
  assert.equal(parsePartId("msg_abc-summary"), undefined)
  assert.equal(parsePartId(undefined), undefined)
})

test("forkTitle keeps 20 code points of the original", () => {
  assert.equal(forkTitle("微观经济学 problem set 5 第二题的讨论"), "Fork · 微观经济学 problem set 5")
  assert.equal(forkTitle("一二三四五六七八九十一二三四五六七八九十多出来"), "Fork · 一二三四五六七八九十一二三四五六七八九十")
  assert.equal(forkTitle("🦞 short"), "Fork · 🦞 short")
  assert.equal(forkTitle(""), "Fork")
  assert.equal(forkTitle(undefined), "Fork")
})

test("boundaryIn cuts right after the message", () => {
  const page = [{ id: "m6" }, { id: "m5" }, { id: "m4" }]
  assert.deepEqual(boundaryIn(page, "m5"), { found: true, before: "m6" })
  assert.deepEqual(boundaryIn(page, "m6"), { found: true, before: undefined })
  assert.deepEqual(boundaryIn(page, "m6", "m7"), { found: true, before: "m7" })
  assert.deepEqual(boundaryIn(page, "m1"), { found: false, newer: "m4" })
  assert.deepEqual(boundaryIn([], "m1", "m4"), { found: false, newer: "m4" })
})

test("compareMessageIds orders forked suffixes numerically", () => {
  const ids = ["msg_a_10", "msg_a_4", "msg_b", "msg_a_5"]
  assert.deepEqual([...ids].sort(compareMessageIds), ["msg_a_4", "msg_a_5", "msg_a_10", "msg_b"])
})

test("draftText trims outer blank lines only", () => {
  assert.equal(draftText("\n  f(λx+(1-λ)y) ≤ λf(x)\n\n"), "f(λx+(1-λ)y) ≤ λf(x)")
  assert.equal(draftText("a\n\nb"), "a\n\nb")
})

test("composePrompt sends a quote as the host composer does", () => {
  assert.deepEqual(composePrompt("  why?  ", undefined), { text: "why?" })
  const sent = composePrompt("why?", "line one\nline two")
  assert.equal(
    sent.text,
    "why?\nThe user quoted the following from earlier in the conversation:\n> line one\n> line two",
  )
  assert.deepEqual(sent.metadata, {
    displayText: "why?",
    comments: [{ type: "quote", text: "line one\nline two" }],
    attachments: [],
  })
  // A quote alone still sends, without an empty first line.
  assert.equal(composePrompt("", "q").text, "The user quoted the following from earlier in the conversation:\n> q")
})

test("readPresentation shows the typed text and the quotes", () => {
  const sent = composePrompt("why?", "q")
  assert.deepEqual(readPresentation(sent.text, sent.metadata), { body: "why?", quotes: ["q"] })
  assert.deepEqual(readPresentation("plain", undefined), { body: "plain", quotes: [] })
  assert.deepEqual(readPresentation("plain", { displayText: 3 }), { body: "plain", quotes: [] })
})

const tool = (name: string, input: unknown, extra: Partial<ToolCall["state"]> = {}, id = name): ToolCall => ({
  type: "tool",
  id,
  name,
  state: { status: "completed", input, ...extra },
})

test("toolInput reads partial JSON while the call streams", () => {
  assert.deepEqual(toolInput(tool("shell", '{"command":"ls"}', { status: "streaming" })), { command: "ls" })
  assert.deepEqual(toolInput(tool("shell", '{"comm', { status: "streaming" })), {})
  assert.deepEqual(toolInput(tool("shell", ["x"])), {})
})

test("toolSummary names calls as the host's rows do", () => {
  assert.deepEqual(toolSummary(tool("bash", { command: "npm test" })), {
    title: { key: "tool.shell" },
    subtitle: "npm test",
    args: [],
    mono: true,
  })
  assert.deepEqual(toolSummary(tool("read", { path: "/p/src/a.ts", offset: 10 })), {
    title: { key: "tool.read" },
    subtitle: "a.ts",
    args: ["offset=10"],
  })
  assert.deepEqual(toolSummary(tool("grep", { path: "/p/src", pattern: "foo" }), "/p"), {
    title: { key: "tool.grep" },
    subtitle: "",
    args: ["pattern=foo"],
  })
  assert.deepEqual(toolSummary(tool("zotero_search", { query: "lin 2024", limit: 5, nested: {} })), {
    title: { key: "tool.called", params: { tool: "zotero_search" } },
    subtitle: "lin 2024",
    args: ["limit=5"],
  })
  assert.deepEqual(toolSummary(tool("task", { agent: "explore", description: "find it" })).title, {
    key: "tool.agent",
    params: { name: "Explore" },
  })
})

test("folder is relative to the project", () => {
  assert.equal(folder("/p/src/a.ts", "/p"), "src")
  assert.equal(folder("/p/a.ts", "/p"), "")
  assert.equal(folder("/elsewhere/a.ts", "/p"), "/elsewhere")
  assert.equal(folder(undefined), "/")
})

test("toolStopped tells a stopped call from a failed one", () => {
  assert.equal(toolStopped(tool("shell", {}, { status: "error", error: { type: "MessageAbortedError" } })), true)
  assert.equal(toolStopped(tool("shell", {}, { status: "error", error: { type: "x", message: "Command cancelled" } })), true)
  assert.equal(toolStopped(tool("shell", {}, { status: "error", error: { type: "Unknown", message: "boom" } })), false)
})

test("activityLabel names a stretch by its main work", () => {
  const read = (path: string) => tool("read", { path }, {}, path)
  assert.deepEqual(activityLabel([read("/a"), read("/b"), read("/a"), tool("grep", { pattern: "x" })]), {
    verb: "activity.explored",
    main: [
      { plural: "activity.files", count: 2 },
      { plural: "activity.searches", count: 1 },
    ],
    others: [],
  })
  const edit = tool("edit", { path: "/p/src/core.ts" })
  assert.deepEqual(activityLabel([read("/a"), tool("bash", { command: "ls" }), edit]), {
    verb: "activity.edited",
    main: ["core.ts"],
    others: [{ plural: "activity.commands", count: 1 }, { plural: "activity.reads", count: 1 }],
  })
  assert.deepEqual(activityLabel([tool("zotero_search", {}), tool("zotero_search", {}, {}, "2")])?.main, ["zotero_search"])
  assert.equal(activityLabel([]), undefined)
})

test("foldTurn folds calls and thoughts between texts", () => {
  const parts: { key: string; part: TurnPart }[] = [
    { key: "m1:0", part: { type: "reasoning", text: "hmm", time: { completed: 1 } } },
    { key: "m1:1", part: { type: "text", text: "Let me look." } },
    { key: "m1:2", part: tool("read", { path: "/a" }) },
    { key: "m2:0", part: { type: "reasoning", text: "", time: { completed: 2 } } },
    { key: "m2:1", part: tool("todowrite", {}) },
    { key: "m2:2", part: { type: "reasoning", text: "ok" } },
    { key: "m2:3", part: tool("bash", { command: "ls" }) },
    { key: "m2:4", part: { type: "text", text: "  " } },
    { key: "m2:5", part: { type: "text", text: "Done." } },
  ]
  const rows = foldTurn(parts)
  assert.deepEqual(
    rows.map((row) => [row.kind, row.key]),
    [
      ["thoughts", "stretch:m1:0"],
      ["text", "text:m1:1"],
      ["group", "stretch:m1:2"],
      ["text", "text:m2:5"],
    ],
  )
  const group = rows[2]
  assert.ok(group?.kind === "group")
  assert.deepEqual(
    group.parts.map((item) => item.key),
    ["m1:2", "m2:2", "m2:3"],
  )
})

test("diffBody drops file headers; stringDiff marks both sides", () => {
  assert.equal(diffBody("Index: a\n===\n--- a\n+++ a\n@@ -1 +1 @@\n-x\n+y\n"), "@@ -1 +1 @@\n-x\n+y")
  assert.equal(stringDiff("a\nb", "c"), "-a\n-b\n+c")
  assert.equal(stringDiff("", "c"), "+c")
})

test("composePrompt with a blank body sends the quote alone", () => {
  assert.equal(composePrompt("  ", "q").text, "The user quoted the following from earlier in the conversation:\n> q")
  assert.equal(composePrompt("  ", "q").metadata?.displayText, "")
})

test("folder of a bare name is empty; a root may end in a slash", () => {
  assert.equal(folder("a.ts"), "")
  assert.equal(folder("/p/src/a.ts", "/p/"), "src")
  assert.equal(folder("/p/a.ts", "/p/"), "")
})

test("toolFailed and shellOutcome follow the host's shell rules", () => {
  const shell = (metadata: unknown, status = "completed") => tool("bash", { command: "npm test" }, { status, metadata })
  assert.equal(toolFailed(shell({ exit: 1 })), true)
  assert.equal(toolFailed(shell({ exit: 0 })), false)
  assert.equal(toolFailed(shell({ exit: "NaN" })), false)
  assert.equal(toolFailed(shell({ timeout: true })), true)
  assert.equal(toolFailed(shell({ interrupted: true })), false)
  assert.equal(toolFailed(tool("read", {}, { status: "error", error: { type: "Unknown", message: "no file" } })), true)
  assert.equal(toolFailed(tool("read", {}, { metadata: { exit: 1 } })), false)
  assert.deepEqual(shellOutcome({ status: "killed" }), { tone: "neutral", label: { key: "shell.stopped" } })
  assert.deepEqual(shellOutcome({ status: "exited", exit: 2 }), {
    tone: "danger",
    label: { key: "shell.exit", params: { code: "2" } },
  })
  assert.equal(shellOutcome({ status: "exited", exit: 0 }), undefined)
})

test("activityLabel counts edited files past three, from the diffs when there are some", () => {
  const edits = ["/a", "/b", "/c", "/d"].map((path) => tool("edit", { path }, {}, path))
  assert.deepEqual(activityLabel(edits)?.main, [{ plural: "activity.files", count: 4 }])
  const patch = tool("apply_patch", {}, { metadata: { files: [{ file: "/x/one.ts", patch: "@@", additions: 1, deletions: 0 }] } })
  assert.deepEqual(activityLabel([patch])?.main, ["one.ts"])
})

test("foldTurn edges: stopped empty calls, the live thought, blank text, pending questions", () => {
  const parts: { key: string; part: TurnPart }[] = [
    { key: "a", part: tool("bash", { command: "ls" }) },
    { key: "b", part: { type: "text", text: "\n " } },
    { key: "c", part: tool("bash", {}, { status: "error", error: { type: "AbortError" } }) },
    { key: "d", part: tool("question", {}, { status: "running" }) },
    { key: "e", part: { type: "reasoning", text: "" } },
  ]
  const rows = foldTurn(parts, "e")
  assert.equal(rows.length, 1)
  assert.ok(rows[0]?.kind === "group")
  assert.deepEqual(
    rows[0].parts.map((item) => item.key),
    ["a", "e"],
  )
  // Not live: an unfinished empty thought a stop cut off has nothing to show.
  assert.deepEqual(
    foldTurn([{ key: "e", part: { type: "reasoning", text: "" } }]),
    [],
  )
})

test("partKeys key calls by id and the rest by their count per type", () => {
  const parts: TurnPart[] = [
    { type: "reasoning", text: "" },
    { type: "text", text: "a" },
    tool("read", {}, {}, "call_1"),
    { type: "text", text: "b" },
  ]
  assert.deepEqual(partKeys("m", parts), ["m:reasoning:0", "m:text:0", "m:tool:call_1", "m:text:1"])
})
