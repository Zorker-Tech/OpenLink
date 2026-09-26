/**
 * The host's local-exec edge: what the telemetry reports, the memory an agent carries, and the client-side
 * tools this build ships.
 */

import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { LOCAL_EXEC_FAILED_EVENT, LOCAL_EXEC_PROVIDER_EVENT, LOCAL_EXEC_REFUSED_EVENT } from "../../source/host/telemetry/local-exec-telemetry.ts";
import { MEMORY_MAX_CONTENT_LENGTH, MEMORY_PROFILE_PROMPT_LIMIT, MEMORY_RECENT_PROMPT_CHAR_BUDGET, MEMORY_RECENT_PROMPT_LIMIT, MEMORY_UI_LIMIT } from "../../source/host/runner/slate-memory.ts";
import { SHIPPED_CLIENT_SIDE_TOOL_V2_UNION } from "../../source/host/transcript/client-side-tool-v2-inventory.ts";

describe("what local execution reports", () => {
  it("uses our own event names for a refusal, a failure and a provider", () => {
    assert.equal(LOCAL_EXEC_REFUSED_EVENT, "slate.local_exec.refused");
    assert.equal(LOCAL_EXEC_FAILED_EVENT, "slate.local_exec.exec_failed");
    assert.equal(LOCAL_EXEC_PROVIDER_EVENT, "slate.local_exec.provider");
  });
});

describe("the memory an agent carries", () => {
  it("bounds what a prompt carries and what the panel shows", () => {
    assert.equal(MEMORY_RECENT_PROMPT_LIMIT, 30);
    assert.equal(MEMORY_RECENT_PROMPT_CHAR_BUDGET, 4_000);
    assert.equal(MEMORY_PROFILE_PROMPT_LIMIT, 100);
    assert.equal(MEMORY_UI_LIMIT, 1_000);
    // One memory is bounded on its own, and a prompt carries a budget rather than a count of them.
    assert.equal(MEMORY_MAX_CONTENT_LENGTH, 500);
    assert.equal(MEMORY_RECENT_PROMPT_CHAR_BUDGET > MEMORY_MAX_CONTENT_LENGTH, true);
  });
});

describe("the client-side tools this build ships", () => {
  it("lists them, and never lists the unspecified value", () => {
    assert.equal(SHIPPED_CLIENT_SIDE_TOOL_V2_UNION.length > 0, true);
    assert.equal(SHIPPED_CLIENT_SIDE_TOOL_V2_UNION.some((tool) => tool.toLowerCase().includes("unspecified")), false);
    assert.equal(new Set(SHIPPED_CLIENT_SIDE_TOOL_V2_UNION).size, SHIPPED_CLIENT_SIDE_TOOL_V2_UNION.length);
  });
});
