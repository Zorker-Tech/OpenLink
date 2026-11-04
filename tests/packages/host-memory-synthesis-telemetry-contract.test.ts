import assert from "node:assert/strict"
import test from "node:test"
import { SlateError } from "../../source/shared/errors/registry.ts"
import { MEMORY_SYNTHESIS_EVENT, memorySynthesisTelemetry } from "../../source/host/telemetry/memory-synthesis-telemetry.ts"

test("the event name is stable and skipped synthesis only records its outcome", () => {
  assert.equal(MEMORY_SYNTHESIS_EVENT, "slate.memory.synthesis")
  assert.deepEqual(memorySynthesisTelemetry({ outcome: "skipped_gate" }), {
    level: "info",
    event: MEMORY_SYNTHESIS_EVENT,
    metadata: { outcome: "skipped_gate" },
  })
})

test("a shed batch warns and includes the registered error tags and item count", () => {
  assert.deepEqual(memorySynthesisTelemetry({
    outcome: "shed",
    cause: SlateError.memorySynthesisEvidenceDropped(),
    itemCount: 0,
  }), {
    level: "warn",
    event: MEMORY_SYNTHESIS_EVENT,
    metadata: {
      outcome: "shed",
      error_code: "SLATE-E0412",
      error_domain: "agent",
      error_retryable: "false",
      item_count: "0",
    },
  })
})

test("failed and successful runs report rounded duration, count and severity", () => {
  assert.deepEqual(memorySynthesisTelemetry({
    outcome: "failed",
    cause: SlateError.memorySynthesisFailed(),
    durationMs: 1.6,
    itemCount: 3,
  }), {
    level: "warn",
    event: MEMORY_SYNTHESIS_EVENT,
    metadata: {
      outcome: "failed",
      error_code: "SLATE-E0413",
      error_domain: "agent",
      error_retryable: "true",
      duration_ms: "2",
      item_count: "3",
    },
  })

  assert.deepEqual(memorySynthesisTelemetry({ outcome: "ok", durationMs: 2.4, itemCount: 0 }), {
    level: "info",
    event: MEMORY_SYNTHESIS_EVENT,
    metadata: { outcome: "ok", duration_ms: "2", item_count: "0" },
  })
})
