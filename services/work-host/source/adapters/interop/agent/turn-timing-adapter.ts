/** Materialize Slate's turn timing record as the message required by the external Agent state. */

import { StepTiming } from "../proto/generated/agent/v1/agent_pb.ts"
import type { SlateTurnTiming } from "../../../host/runner/turn-settle.ts"

export function createInteropTurnTiming(timing: SlateTurnTiming): SlateTurnTiming {
  return new StepTiming({
    timestampMs: timing.timestampMs,
    durationMs: timing.durationMs,
  })
}
