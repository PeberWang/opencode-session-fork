import assert from "node:assert/strict"
import { test } from "node:test"
import {
  WRITEBACK_DEFAULTS,
  answered,
  changedPaths,
  contentHash,
  fitSummary,
  forkName,
  formatSummary,
  length,
  modelAttempts,
  modelRefused,
  ownMessages,
  parseSummary,
  runWriteback,
  writebackConfig,
  writebackMeta,
  writebackState,
  type ForkMessage,
  type Summary,
  type SummaryLabels,
  type WritebackDeps,
  type WritebackMeta,
  type WritebackState,
} from "../src/writeback.ts"

const labels: SummaryLabels = {
  conclusion: "结论：",
  changes: "改动：",
  open: "还悬着：",
  none: "无",
  separator: "：",
  more: (count) => `另有 ${count} 个文件`,
}

const FORKED = 1000
const copied: ForkMessage = { id: "msg_a_1", type: "user", time: { created: 10 }, text: "old question" }
const question: ForkMessage = { id: "msg_q", type: "user", time: { created: FORKED + 1 }, text: "这段怎么改？" }
const edit = (path: string, status = "completed"): ForkMessage => ({
  id: `msg_${path}`,
  type: "assistant",
  time: { created: FORKED + 2 },
  content: [
    { type: "text", text: "改好了" },
    { type: "tool", id: `call_${path}`, name: "edit", state: { status, input: { path } } } as never,
  ],
})
const reply: ForkMessage = {
  id: "msg_r",
  type: "assistant",
  time: { created: FORKED + 3 },
  content: [{ type: "text", text: "它的意思是……" }],
}

test("writebackConfig reads options.writeback and keeps defaults for the rest", () => {
  assert.deepEqual(writebackConfig(undefined), WRITEBACK_DEFAULTS)
  assert.deepEqual(writebackConfig({ writeback: { enabled: false, maxChars: 200, model: "openai/gpt-x", timeoutMs: 8000 } }), {
    enabled: false,
    maxChars: 200,
    confirm: true,
    model: { providerID: "openai", id: "gpt-x" },
    timeoutMs: 8000,
  })
  assert.deepEqual(writebackConfig({ writeback: { model: "deepseek/deepseek-v4-pro#low" } }).model, {
    providerID: "deepseek",
    id: "deepseek-v4-pro",
    variant: "low",
  })
  const bad = writebackConfig({ writeback: { maxChars: -1, model: "nomodel", confirm: "yes", timeoutMs: Number.NaN } })
  assert.deepEqual(bad, WRITEBACK_DEFAULTS)
})

test("ownMessages, answered and changedPaths read only what the fork did", () => {
  const all = [copied, question, edit("/repo/src/a.ts"), edit("/repo/src/a.ts"), edit("/elsewhere/b.md"), edit("/repo/c.ts", "error")]
  const own = ownMessages(all, FORKED)
  assert.equal(own.includes(copied), false)
  assert.deepEqual(changedPaths(own, "/repo"), ["src/a.ts", "/elsewhere/b.md"])
  assert.equal(answered([question]), false)
  assert.equal(answered([question, reply]), true)
})

test("parseSummary takes the file list from the calls, not the model", () => {
  const raw = '```json\n{"conclusion":"用方案 B。","files":{"src/a.ts":"改了阈值","ghost.ts":"不存在"},"open":["测试","文档","发版","多余"]}\n```'
  const summary = parseSummary(raw, ["src/a.ts", "src/b.ts"])!
  assert.equal(summary.conclusion, "用方案 B。")
  assert.deepEqual(summary.files, [
    { path: "src/a.ts", note: "改了阈值" },
    { path: "src/b.ts", note: "" },
  ])
  assert.deepEqual(summary.open, ["测试", "文档", "发版"])
  assert.equal(parseSummary("not json", []), undefined)
  const many = parseSummary("{}", Array.from({ length: 13 }, (_, index) => `f${index}.ts`))!
  assert.equal(many.files.length, 10)
  assert.equal(many.more, 3)
})

test("formatSummary always has three sections; fitSummary keeps it under the limit", () => {
  const empty: Summary = { conclusion: "", files: [], more: 0, open: [] }
  assert.equal(formatSummary(empty, labels), "结论：无\n改动：\n- 无\n还悬着：\n- 无")
  const long: Summary = {
    conclusion: "定下来用方案 B，".repeat(20),
    files: Array.from({ length: 10 }, (_, index) => ({ path: `src/module-${index}/file.ts`, note: "调整了这个模块的边界判断" })),
    more: 4,
    open: ["还要补一组回归测试，覆盖空输入", "文档没更新", "要不要发版"],
  }
  const fitted = fitSummary(long, labels, 300)
  const text = formatSummary(fitted, labels)
  assert.ok(length(text) <= 300, `${length(text)} characters`)
  for (const heading of ["结论：", "改动：", "还悬着："]) assert.ok(text.includes(heading))
  assert.ok(text.includes("另有"))
  // An over-long answer, as a model without thinking writes one: cut evenly, every section keeps something.
  const wordy: Summary = {
    conclusion: "The fork settled two notation points and renamed the cutoff, with hats for cutoffs and bars for averages. ".repeat(2),
    files: [
      { path: "model/m1-backward-20261123.md", note: "Added the regime II aligned-mixing equilibrium and renamed the cutoff." },
      { path: "model/m1-setup-20261119.md", note: "Flagged T5 and T10 for the change." },
      { path: "model/model-v2-20261115.md", note: "Recorded the hat/bar rule in Decision 9." },
    ],
    more: 0,
    open: ["Whether the inclusive default is adopted.", "Whether stage-3 stakes are scaled.", "Redo the stage-2 pooling row."],
  }
  const even = fitSummary(wordy, labels, 300)
  assert.ok(length(formatSummary(even, labels)) <= 300)
  assert.ok(even.conclusion.length > 0)
  assert.equal(even.open.length, 3)
  assert.equal(even.files.length, 3)
  // A summary that fits stays as it is.
  const short: Summary = { conclusion: "用 B。", files: [{ path: "a.ts", note: "改阈值" }], more: 0, open: [] }
  assert.deepEqual(fitSummary(short, labels, 300), short)
})

test("markers: metadata, state, hash, names", () => {
  assert.equal(writebackMeta({ source: "subagent", forkID: "x", hash: "y" }), undefined)
  assert.equal(writebackMeta({ source: "session-fork", forkID: "ses_1", hash: "abc" })?.forkID, "ses_1")
  assert.deepEqual(writebackState({ sessionFork: { written: "h" } }), { written: "h" })
  assert.deepEqual(writebackState(undefined), {})
  assert.equal(contentHash("a"), contentHash("a"))
  assert.notEqual(contentHash("a"), contentHash("b"))
  assert.match(contentHash("任何内容"), /^[0-9a-f]{8}$/)
  assert.equal(forkName("Fork · 微观经济学 problem"), "微观经济学 problem")
  assert.equal(forkName(undefined), "Fork")
})

// ---- The flow, with a fake server -----------------------------------------------------------------------------------

type Fake = {
  metadata: Record<string, unknown>
  messages: ForkMessage[]
  main: WritebackMeta[]
  writes: { mainID: string; text: string; description: string; metadata: WritebackMeta }[]
  confirms: { title: string; body: string }[]
  prompts: number
  models: { providerID: string; id: string; variant?: string }[]
  logs: string[]
  answer: boolean
  generate: (signal: AbortSignal) => Promise<string>
  write?: () => Promise<void>
}

const SUMMARY = '{"conclusion":"阈值改成 0.8，按方案 B 实施。","files":{"src/a.ts":"调了阈值"},"open":["补回归测试"]}'

function fake(overrides: Partial<Fake> = {}): Fake {
  return {
    metadata: {},
    messages: [copied, question, edit("/repo/src/a.ts")],
    main: [],
    writes: [],
    confirms: [],
    prompts: 0,
    models: [],
    logs: [],
    answer: true,
    generate: async () => SUMMARY,
    ...overrides,
  }
}

function deps(server: Fake, config: Partial<WritebackDeps["config"]> = {}, timer?: WritebackDeps["timer"]): WritebackDeps {
  return {
    config: { ...WRITEBACK_DEFAULTS, ...config },
    forkID: "ses_fork",
    labels,
    description: (name) => `来自 Fork · ${name}`,
    load: async () => ({
      title: "Fork · 主线标题",
      created: FORKED,
      mainID: "ses_main",
      root: "/repo",
      metadata: server.metadata,
      messages: server.messages,
    }),
    existing: async () => server.main.some((meta) => meta.forkID === "ses_fork"),
    generate: (_prompt, model, signal) => {
      server.prompts++
      server.models.push(model)
      return server.generate(signal)
    },
    confirm: async (preview) => {
      server.confirms.push(preview)
      return server.answer
    },
    write: async (input) => {
      await server.write?.()
      server.writes.push(input)
      server.main.push(input.metadata)
    },
    remember: async (state: WritebackState, metadata) => {
      server.metadata = { ...(metadata as object), sessionFork: state }
    },
    log: (line) => server.logs.push(line),
    timer,
  }
}

test("closing a fork that changed files writes one notice with three sections under 300 characters", async () => {
  const server = fake()
  const outcome = await runWriteback(deps(server))
  assert.equal(outcome.status, "written")
  assert.equal(server.confirms.length, 1)
  assert.equal(server.writes.length, 1)
  const write = server.writes[0]!
  assert.equal(write.mainID, "ses_main")
  assert.equal(write.description, "来自 Fork · 主线标题")
  assert.equal(write.metadata.source, "session-fork")
  assert.equal(write.metadata.forkID, "ses_fork")
  assert.equal(write.metadata.hash, outcome.status === "written" ? outcome.hash : "")
  assert.deepEqual(write.metadata.files, [{ path: "src/a.ts", note: "调了阈值" }])
  const body = server.confirms[0]!.body
  assert.ok(length(body) <= 300)
  assert.ok(write.text.includes(body))
  assert.ok(write.text.startsWith('<fork-writeback fork="ses_fork"'))
  for (const heading of ["结论：", "改动：", "还悬着："]) assert.ok(body.includes(heading))
  assert.deepEqual(writebackState(server.metadata), { written: write.metadata.hash })
  assert.equal(server.logs.length, 0)
})

test("closing the same fork again, also after a restart, writes nothing more", async () => {
  const server = fake()
  await runWriteback(deps(server))
  const again = await runWriteback(deps(server))
  assert.deepEqual(again, { status: "skipped", reason: "already written" })
  assert.equal(server.writes.length, 1)
  assert.equal(server.prompts, 1)
  // The fork's metadata lost (say the update failed): the main session's marker still stops it.
  server.metadata = {}
  const third = await runWriteback(deps(server))
  assert.equal(third.status, "skipped")
  assert.equal(server.writes.length, 1)
  assert.equal(server.prompts, 1)
  assert.equal(writebackState(server.metadata).written, "existing")
})

test("answering no in the dialog writes nothing, and asks again only once the fork went on", async () => {
  const server = fake({ answer: false })
  assert.deepEqual(await runWriteback(deps(server)), { status: "declined" })
  assert.equal(server.writes.length, 0)
  assert.equal(server.main.length, 0)
  const again = await runWriteback(deps(server))
  assert.equal(again.status, "skipped")
  assert.equal(server.confirms.length, 1)
  server.messages = [...server.messages, reply]
  server.answer = true
  assert.equal((await runWriteback(deps(server))).status, "written")
  assert.equal(server.confirms.length, 2)
})

test("a fork that only asked a question writes nothing and asks nothing", async () => {
  const server = fake({
    messages: [copied, question, reply],
    generate: async () => '{"conclusion":"","files":{},"open":[]}',
  })
  const outcome = await runWriteback(deps(server))
  assert.deepEqual(outcome, { status: "skipped", reason: "no changes and no conclusion" })
  assert.equal(server.confirms.length, 0)
  assert.equal(server.writes.length, 0)
  // Nothing answered at all: not even the model is asked.
  const unanswered = fake({ messages: [copied, question] })
  assert.equal((await runWriteback(deps(unanswered))).status, "skipped")
  assert.equal(unanswered.prompts, 0)
})

test("offline: a summary that fails or times out skips with one log line and never throws", async () => {
  const offline = fake({ generate: async () => Promise.reject(new TypeError("Failed to fetch")) })
  const outcome = await runWriteback(deps(offline))
  assert.deepEqual(outcome, { status: "skipped", reason: "summary failed: Failed to fetch" })
  assert.deepEqual(offline.logs, ["[session-fork] writeback skipped (ses_fork): summary failed: Failed to fetch"])
  assert.equal(offline.writes.length, 0)

  // A model that never answers: the timer fires at the timeout and aborts the call.
  let fire: (() => void) | undefined
  let delay = 0
  let aborted = false
  const hanging = fake({
    generate: (signal) =>
      new Promise<string>(() => {
        signal.addEventListener("abort", () => (aborted = true))
      }),
  })
  const run = runWriteback(
    deps(hanging, {}, {
      set: (callback, ms) => {
        fire = callback
        delay = ms
        return 1
      },
      clear: () => {},
    }),
  )
  await new Promise((resolve) => setImmediate(resolve))
  assert.equal(delay, 5000)
  fire!()
  assert.deepEqual(await run, { status: "skipped", reason: "summary failed: timed out after 5000ms" })
  assert.equal(aborted, true)
  assert.equal(hanging.logs.length, 1)
  assert.equal(hanging.confirms.length, 0)
})

test("a model ref the server refuses costs one retry without its variant, and nothing more", async () => {
  let calls = 0
  const server = fake({
    generate: async () => {
      calls++
      if (calls === 1) throw new Error("Model not found: deepseek/deepseek-flash")
      return SUMMARY
    },
  })
  assert.equal((await runWriteback(deps(server))).status, "written")
  assert.deepEqual(server.models, [
    { providerID: "deepseek", id: "deepseek-flash", variant: "none" },
    { providerID: "deepseek", id: "deepseek-flash" },
  ])
  assert.deepEqual(server.logs, [])

  // Refused twice: one log line, and the error the last attempt raised.
  const twice = fake({ generate: async () => Promise.reject(new Error("Model not found: deepseek/deepseek-flash")) })
  assert.deepEqual(await runWriteback(deps(twice)), {
    status: "skipped",
    reason: "summary failed: Model not found: deepseek/deepseek-flash",
  })
  assert.equal(twice.prompts, 2)

  // A failure that says nothing about the reference is not retried.
  const offline = fake({ generate: async () => Promise.reject(new TypeError("Failed to fetch")) })
  assert.equal((await runWriteback(deps(offline))).status, "skipped")
  assert.equal(offline.prompts, 1)

  assert.deepEqual(modelAttempts({ providerID: "x", id: "y" }), [{ providerID: "x", id: "y" }])
  assert.deepEqual(modelAttempts({ providerID: "x", id: "y", variant: "none" }), [
    { providerID: "x", id: "y", variant: "none" },
    { providerID: "x", id: "y" },
  ])
  assert.equal(modelRefused(new Error("Model not found: x/y")), true)
  assert.equal(modelRefused(new Error("Variant unavailable for x/y: none")), true)
  assert.equal(modelRefused(new Error("Failed to fetch")), false)
})

test("a failed write, a load that throws, or the switch off: skipped, logged, nothing thrown", async () => {
  const failing = fake({ write: async () => Promise.reject(new Error("503")) })
  assert.deepEqual(await runWriteback(deps(failing)), { status: "skipped", reason: "write failed: 503" })
  assert.equal(writebackState(failing.metadata).written, undefined)

  const broken = { ...deps(fake()), load: async () => Promise.reject(new Error("offline")) }
  assert.deepEqual(await runWriteback(broken), { status: "skipped", reason: "failed: offline" })

  const off = fake()
  assert.deepEqual(await runWriteback(deps(off, { enabled: false })), { status: "skipped", reason: "disabled" })
  assert.equal(off.prompts, 0)
})

test("with confirm off, it writes without asking", async () => {
  const server = fake()
  assert.equal((await runWriteback(deps(server, { confirm: false }))).status, "written")
  assert.equal(server.confirms.length, 0)
  assert.equal(server.writes.length, 1)
})
