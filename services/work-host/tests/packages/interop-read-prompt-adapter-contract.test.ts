import assert from "node:assert/strict"
import test from "node:test"

import { resolveReadPromptProfile } from "../../source/adapters/interop/agent/read-tool-prompt-adapter.ts"

test("external read conventions resolve to a small Slate-owned prompt profile", () => {
  assert.deepEqual(resolveReadPromptProfile("dsv3-1018", {}), {
    toolName: "read_file",
    argumentStyle: "workspace-target",
    allowNegativeOffset: false,
    descriptionStyle: "standard",
  })
  assert.deepEqual(resolveReadPromptProfile("haiku", {}), {
    toolName: "Read",
    argumentStyle: "path-range",
    allowNegativeOffset: false,
    descriptionStyle: "full",
  })
  assert.deepEqual(resolveReadPromptProfile("cursor-0226", {}), {
    toolName: "Read",
    argumentStyle: "path-offset",
    allowNegativeOffset: true,
    descriptionStyle: "compact-image",
  })
})

test("the image-only profile skips version resolution and honors caller-selected offset support", () => {
  assert.deepEqual(resolveReadPromptProfile("future-model", { imageOnly: true }), {
    toolName: "ViewImage",
    argumentStyle: "path-only",
    allowNegativeOffset: false,
    descriptionStyle: "image-only",
  })
  assert.equal(resolveReadPromptProfile("latest", { allowNegativeOffset: true }).allowNegativeOffset, true)
  assert.throws(() => resolveReadPromptProfile("future-model", {}), /Unhandled version/)
})
