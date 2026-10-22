import assert from "node:assert/strict";
import { describe, it } from "node:test";

import {
  IDLE_TEACH_RECORDING_STATUS,
  SLATE_TEACH_MAX_DURATION_MS,
} from "../../source/shared/agents/teach-recording.ts";

describe("a teaching recording's limits and idle state", () => {
  it("runs for ten minutes at most", () => {
    assert.equal(SLATE_TEACH_MAX_DURATION_MS, 600_000);
    assert.equal(Number.isInteger(SLATE_TEACH_MAX_DURATION_MS), true);
  });

  it("is idle until an agent starts one", () => {
    assert.deepEqual(IDLE_TEACH_RECORDING_STATUS, {
      state: "idle",
      agentId: null,
      startedAtMs: null,
      maxDurationMs: SLATE_TEACH_MAX_DURATION_MS,
    });
    assert.deepEqual(Object.keys(IDLE_TEACH_RECORDING_STATUS), ["state", "agentId", "startedAtMs", "maxDurationMs"]);
    assert.equal(JSON.stringify(IDLE_TEACH_RECORDING_STATUS), '{"state":"idle","agentId":null,"startedAtMs":null,"maxDurationMs":600000}');
  });

  it("carries the exported limit itself", () => {
    assert.equal(IDLE_TEACH_RECORDING_STATUS.maxDurationMs, SLATE_TEACH_MAX_DURATION_MS);
    assert.equal(Object.isFrozen(IDLE_TEACH_RECORDING_STATUS), false, "the status is a plain object literal");
  });
});
