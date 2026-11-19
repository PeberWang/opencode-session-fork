import assert from "node:assert/strict"
import { test } from "node:test"
import { boundaryIn, compareMessageIds, draftText, forkTitle, parsePartId } from "../src/core.ts"

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
