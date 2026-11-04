import assert from "node:assert/strict";
import { describe, it } from "node:test";

import {
  STRUCTURED_LOG_FUTURE_TIMESTAMP_MAX_SKEW_MS,
  STRUCTURED_LOG_REPLAY_MAX_AGE_MS,
} from "../../source/packages/constants/structured-log.ts";

describe("structured-log retention limits", () => {
  it("keeps the replay age and future-clock allowance in milliseconds", () => {
    assert.equal(STRUCTURED_LOG_REPLAY_MAX_AGE_MS, 61_200_000);
    assert.equal(STRUCTURED_LOG_FUTURE_TIMESTAMP_MAX_SKEW_MS, 7_200_000);
  });
});
