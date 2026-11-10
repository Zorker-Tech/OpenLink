import assert from "node:assert/strict"
import { test } from "node:test"

import {
  createDisplayResolution,
  parseDisplayIndex,
  parseDisplayModes,
} from "../../source/packages/local-exec/computer-use/display-resolution-policy.ts"

test("the display policy accepts the final X11 index and keeps its numeric prefix", () => {
  assert.equal(parseDisplayIndex("node:display:007.0"), 7)
  assert.throws(() => parseDisplayIndex("display-without-index"), /missing ':'/)
})

test("an unusable active mode falls back to the current screen dimensions", () => {
  const output = [
    "Screen 0: minimum 1 x 1, current 1680 x 1050, maximum 8192 x 8192",
    "   0x50  75.00*+",
  ].join("\n")

  assert.deepEqual(parseDisplayModes(output), { width: 1680, height: 1050, refreshRate: 75 })
})

test("the input frame keeps the screen shape at its fixed width", () => {
  assert.deepEqual(createDisplayResolution(2560, 1440), {
    display: { width: 2560, height: 1440 },
    api: { width: 1280, height: 720 },
  })
})
