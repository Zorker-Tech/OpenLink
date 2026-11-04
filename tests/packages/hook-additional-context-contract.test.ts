import assert from "node:assert/strict"
import { describe, it } from "node:test"

import {
  appendHookContextEntries,
  createHookContextEntries,
  HOOK_CONTEXT_MAX_CHARACTERS,
  HookContextLimitError,
  type HookContextEntry,
} from "../../source/packages/hooks-carriers/hook-additional-context.ts"

describe("hook additional context", () => {
  it("trims useful text and omits null, empty, or whitespace-only values", () => {
    assert.deepEqual(createHookContextEntries({ event: "sessionStart", text: undefined }), [])
    assert.deepEqual(createHookContextEntries({ event: "sessionStart", text: null }), [])
    assert.deepEqual(createHookContextEntries({ event: "sessionStart", text: "  \n  " }), [])
    assert.deepEqual(createHookContextEntries({ event: "sessionStart", text: "  keep me  " }), [
      { event: "sessionStart", text: "keep me" },
    ])
  })

  it("measures the trimmed value, accepts the exact limit, and rejects one more character", () => {
    const exact = createHookContextEntries({ event: "preToolUse", text: `  ${"x".repeat(HOOK_CONTEXT_MAX_CHARACTERS)}  ` })
    assert.equal(exact[0]?.text.length, HOOK_CONTEXT_MAX_CHARACTERS)

    assert.throws(
      () => createHookContextEntries({ event: "preToolUse", text: "x".repeat(HOOK_CONTEXT_MAX_CHARACTERS + 1) }),
      (error: unknown) => {
        assert.ok(error instanceof HookContextLimitError)
        assert.equal(error.event, "preToolUse")
        assert.equal(error.actualCharacters, HOOK_CONTEXT_MAX_CHARACTERS + 1)
        assert.equal(error.maximumCharacters, HOOK_CONTEXT_MAX_CHARACTERS)
        return true
      },
    )
  })

  it("appends only when a destination exists and preserves the entries and their order", () => {
    const destination: HookContextEntry[] = []
    const additions = createHookContextEntries({ event: "sessionStart", text: "first" })
      .concat(createHookContextEntries({ event: "postToolUse", text: "second" }))
    appendHookContextEntries(undefined, additions)
    appendHookContextEntries(destination, [])
    assert.deepEqual(destination, [])

    appendHookContextEntries(destination, additions)
    assert.deepEqual(destination, [
      { event: "sessionStart", text: "first" },
      { event: "postToolUse", text: "second" },
    ])
    assert.equal(destination[0], additions[0])
    assert.equal(destination[1], additions[1])
  })
})
