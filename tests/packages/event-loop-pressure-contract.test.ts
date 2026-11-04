import assert from "node:assert/strict";
import { describe, it } from "node:test";

import {
  EventLoopPressureThresholdDefault,
  EventLoopPressureTrackerDefault,
} from "../../source/packages/shell-exec/event-loop-pressure.ts";

describe("event-loop pressure thresholds", () => {
  it("preserves named values and numeric reverse lookups", () => {
    assert.deepEqual(Object.entries(EventLoopPressureThresholdDefault), [
      ["50", "EventLoopDelayP95Ms"],
      ["EventLoopDelayP95Ms", 50],
      ["EventLoopUtilization", 0.7],
      ["0.7", "EventLoopUtilization"],
    ]);
    assert.deepEqual(Object.entries(EventLoopPressureTrackerDefault), [
      ["20", "EventLoopResolutionMs"],
      ["250", "SampleIntervalMs"],
      ["SampleIntervalMs", 250],
      ["EventLoopResolutionMs", 20],
    ]);
    assert.equal(EventLoopPressureThresholdDefault[50], "EventLoopDelayP95Ms");
    assert.equal(EventLoopPressureTrackerDefault[250], "SampleIntervalMs");
  });
});
