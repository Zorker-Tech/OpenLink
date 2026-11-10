import assert from "node:assert/strict"
import test from "node:test"
import { SlateError } from "../../source/shared/errors/registry.ts"
import {
  corruptTailKind,
  JOURNAL_OUTCOME_EVENT,
  journalOutcomeLevel,
  journalOutcomeTelemetry,
  type JournalOutcomeReport,
} from "../../source/host/telemetry/journal-outcome-telemetry.ts"

function report(overrides: Partial<JournalOutcomeReport> = {}): JournalOutcomeReport {
  return {
    outcome: "recovered",
    op: "replay",
    conversationId: "conversation-1",
    durationMs: 1.6,
    ...overrides,
  }
}

test("only a non-missing corrupt tail raises a non-failure outcome to a warning", () => {
  assert.equal(corruptTailKind(undefined), undefined)
  assert.equal(corruptTailKind(SlateError.journalCorruptTail({ tail: "missing" })), "missing")
  assert.equal(corruptTailKind(SlateError.journalCorruptTail({ tail: "truncated" })), "truncated")
  assert.equal(journalOutcomeLevel(report()), "info")
  assert.equal(journalOutcomeLevel(report({ cause: SlateError.journalCorruptTail({ tail: "missing" }) })), "info")
  assert.equal(journalOutcomeLevel(report({ cause: SlateError.journalCorruptTail({ tail: "truncated" }) })), "warn")
  assert.equal(journalOutcomeLevel(report({ outcome: "failed", cause: SlateError.journalCorruptTail({ tail: "missing" }) })), "error")
})

test("the event reports bounded error tags and string-valued journal measurements", () => {
  const telemetry = journalOutcomeTelemetry(report({
    outcome: "recovered",
    entryCount: 0,
    bytes: 2048,
    durationMs: 1.6,
    cause: SlateError.journalCorruptTail({ tail: "truncated", errno: "EIO", message: "must not escape" }),
  }))

  assert.equal(telemetry.level, "warn")
  assert.equal(telemetry.event, JOURNAL_OUTCOME_EVENT)
  assert.deepEqual(telemetry.metadata, {
    op: "replay",
    outcome: "recovered",
    conversation_id: "conversation-1",
    entry_count: "0",
    bytes: "2048",
    duration_ms: "2",
    error_code: "SLATE-E0722",
    error_domain: "storage",
    error_retryable: "false",
    tail: "truncated",
    errno: "EIO",
  })
})

test("absent counters stay unset, while the duration is always emitted", () => {
  assert.deepEqual(journalOutcomeTelemetry(report({ durationMs: 4.4 })).metadata, {
    op: "replay",
    outcome: "recovered",
    conversation_id: "conversation-1",
    entry_count: undefined,
    bytes: undefined,
    duration_ms: "4",
  })
})
