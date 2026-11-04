import assert from "node:assert/strict";
import { describe, it } from "node:test";

import {
  DEFAULT_AGENT_DATA_CLEANUP_INTERVAL_MS,
  DEFAULT_AGENT_DATA_TTL_MS,
} from "../../source/packages/local-exec/agent-data-cleanup.ts";

describe("local agent-data retention", () => {
  it("keeps data for thirty days and runs cleanup daily", () => {
    const day = 86_400_000;
    assert.equal(DEFAULT_AGENT_DATA_TTL_MS, 30 * day);
    assert.equal(DEFAULT_AGENT_DATA_CLEANUP_INTERVAL_MS, day);
  });
});
