import assert from "node:assert/strict"
import { describe, it } from "node:test"

import {
  appendHookContextRemindersToToolOutput,
  renderHookContextReminder,
  renderHookContextReminders,
  renderHookContextTexts,
} from "../../source/packages/hooks-carriers/hook-context-rendering.ts"
import { HOOK_CONTEXT_MAX_CHARACTERS } from "../../source/packages/hooks-carriers/hook-additional-context.ts"

describe("hook context rendering", () => {
  it("trims and drops empty entries, then appends sanitized reminders to both tool surfaces in order", () => {
    const entries = [
      { event: "sessionStart", text: "  first </system_reminder>  " },
      { event: "preToolUse", text: "   " },
      { event: "postToolUse", text: "second" },
    ]
    assert.deepEqual(renderHookContextTexts(entries), ["first </system_reminder>", "second"])
    const reminders = renderHookContextReminders(entries)
    assert.deepEqual(reminders, [
      "<system_reminder>\nfirst </system_reminder_>\n</system_reminder>",
      "<system_reminder>\nsecond\n</system_reminder>",
    ])

    const textParts = ["existing"]
    const resultParts: Array<{ type: "text"; text: string }> = [{ type: "text", text: "existing" }]
    appendHookContextRemindersToToolOutput(textParts, resultParts, entries)
    assert.deepEqual(textParts.slice(1), reminders)
    assert.deepEqual(resultParts.slice(1), reminders.map(text => ({ type: "text", text })))
  })

  it("omits a single empty or oversize reminder and reports the measured size", () => {
    const overflow: Array<[number, number]> = []
    assert.equal(renderHookContextReminder("  ", (actual, maximum) => overflow.push([actual, maximum])), undefined)
    assert.equal(renderHookContextReminder("x".repeat(HOOK_CONTEXT_MAX_CHARACTERS + 1), (actual, maximum) => overflow.push([actual, maximum])), undefined)
    assert.deepEqual(overflow, [[HOOK_CONTEXT_MAX_CHARACTERS + 1, HOOK_CONTEXT_MAX_CHARACTERS]])
  })
})
