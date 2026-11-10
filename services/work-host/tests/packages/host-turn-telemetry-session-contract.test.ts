import assert from "node:assert/strict"
import test from "node:test"

import { TURN_OUTCOME_EVENT, TURN_START_EVENT } from "../../source/shared/observability/telemetry-events.ts"
import { SlateTurnTelemetryImpl, type TurnTelemetryMetadata } from "../../source/host/telemetry/turn-telemetry-session.ts"

test("a turn is announced when its model is known and its finish is recorded once", () => {
  const telemetry = {
    events: [] as Array<{ name: string; metadata: TurnTelemetryMetadata }>,
    emitTurnEvent(name: string, metadata: TurnTelemetryMetadata) {
      this.events.push({ name, metadata })
    },
  }
  let finalized = 0
  const turn = new SlateTurnTelemetryImpl(
    telemetry,
    { conversationId: "conversation-1", turnType: "user" },
    () => { finalized += 1 },
    (_error, detail) => ({ error_message: detail.message }),
  )

  turn.setRequestId("request-1")
  turn.setModel("model-1")
  turn.setModel("model-2")
  turn.noteRetry({ delayMs: 120, cause: "overloaded" })
  turn.noteRetry({ delayMs: 80 })
  turn.finalize("complete")
  turn.finalize("ignored")

  const observed = [...telemetry.events]
  assert.equal(observed.length, 2)
  assert.equal(observed[0]?.name, TURN_START_EVENT)
  assert.deepEqual(observed[0]?.metadata, {
    turn_type: "user",
    conversation_id: "conversation-1",
    request_id: "request-1",
    model_intent: "model-1",
  })
  assert.equal(observed[1]?.name, TURN_OUTCOME_EVENT)
  assert.equal(observed[1]?.metadata.outcome, "complete")
  assert.equal(observed[1]?.metadata.retry_count, "2")
  assert.equal(observed[1]?.metadata.backoff_total_ms, "200")
  assert.equal(observed[1]?.metadata.retry_cause, "overloaded")
  assert.equal(typeof observed[1]?.metadata.duration_ms, "string")
  assert.equal(finalized, 1)
})
