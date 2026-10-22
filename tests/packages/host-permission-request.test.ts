import { test } from "node:test"
import assert from "node:assert/strict"

import { summarizePermissionRequest } from "../../source/host/runner/tools/slate-permission-request.ts"

test("a permission request from an older version is summarized in one sentence", () => {
  assert.equal(
    summarizePermissionRequest({ title: "Read a file", reason: "the agent needs it" }),
    "Legacy permission request (no longer actionable): Read a file \u2014 the agent needs it",
  )
  assert.equal(
    summarizePermissionRequest({ title: "", reason: "" }),
    "Legacy permission request (no longer actionable):  \u2014 ",
    "an empty request still reads as the sentence it is",
  )
})

test("the request's own words are used as they came", () => {
  assert.equal(
    summarizePermissionRequest({ title: "  padded  ", reason: "\ttabbed\n" }),
    "Legacy permission request (no longer actionable):   padded   \u2014 \ttabbed\n",
    "nothing is trimmed, and a newline in a value stays where it was",
  )
  assert.equal(
    summarizePermissionRequest({ title: "ünïcode 文件", reason: "😀" }),
    "Legacy permission request (no longer actionable): ünïcode 文件 \u2014 😀",
  )
  const summary = summarizePermissionRequest({ title: "a — b", reason: "c — d" })
  assert.equal(summary, "Legacy permission request (no longer actionable): a — b \u2014 c — d", "a dash in the value is not the separator")
})

test("extra fields are not part of the sentence", () => {
  const summary = summarizePermissionRequest({ title: "T", reason: "R", extra: true } as never)
  assert.equal(summary, "Legacy permission request (no longer actionable): T \u2014 R")
  assert.equal(summary.includes("extra"), false)
})
