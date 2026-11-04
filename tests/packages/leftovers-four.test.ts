/**
 * The platform's own agents, its telemetry names, how an attachment is described, and the maintenance a
 * session runs over its own files.
 */

import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { GROUP_MAX_MEMBERS, isSlateAgentPurpose, isSlateDefaultAgentName, SLATE_AGENT_PURPOSES, SLATE_DEFAULT_AGENT_NAME } from "../../source/shared/agents/agents.ts";
import { SLATE_LOG_KEY, TELEMETRY_DROPPED_EVENT, TELEMETRY_DROP_REASONS } from "../../source/shared/observability/telemetry-events.ts";
import { classifyAttachment, classifyMimeType, classifyPathLike, countAttachmentKinds } from "../../source/shared/media/attachment-summary.ts";
import { MCP_ERROR_RESULT_CLASS } from "../../source/shared/node/mcp/mcp-diagnostics.ts";
import { SlateMcpListingSummaries } from "../../source/shared/node/mcp/mcp-listing-summaries.ts";
import { LIST_TOOLS_TIMEOUT_MS, SlateBackendMcpExecError } from "../../source/adapters/interop/cursor-backend/backend-mcp-exec.ts";
import { HIDDEN_ENTRY_REPAIR_VERSION } from "../../source/host/extensions/session/session-maintenance.ts";

describe("the agents the platform runs for itself", () => {
  it("names their purposes and tells one of them from anything else", () => {
    assert.deepEqual([...SLATE_AGENT_PURPOSES], ["disk-saver", "plugin-auth"]);
    assert.equal(isSlateAgentPurpose("disk-saver"), true);
    assert.equal(isSlateAgentPurpose("a-user-agent"), false);
    assert.equal(isSlateDefaultAgentName(SLATE_DEFAULT_AGENT_NAME), true);
    assert.equal(GROUP_MAX_MEMBERS > 0, true);
  });
});

describe("the names the platform's telemetry uses", () => {
  it("files a log line under our key and names the reasons a report is dropped", () => {
    assert.equal(SLATE_LOG_KEY, "slate");
    assert.equal(TELEMETRY_DROPPED_EVENT, "slate.telemetry.dropped");
    assert.deepEqual([...TELEMETRY_DROP_REASONS], ["ship_failed", "overflow_evicted", "replay_expired", "backend_dropped", "account_rotated"]);
  });
});

describe("how an attachment is described", () => {
  it("tells what a file is from its type, and what it is not from its name", () => {
    assert.equal(classifyMimeType("image/png"), "image");
    assert.equal(classifyMimeType("video/mp4"), "video");
    assert.equal(classifyMimeType("application/pdf"), "pdf");
    assert.equal(classifyPathLike("a.png"), "image");
    assert.equal(classifyPathLike("/tmp/a.bin"), null);
    assert.equal(typeof classifyAttachment, "function");
    assert.equal(typeof countAttachmentKinds, "function");
  });
});

describe("what an MCP call did while it ran", () => {
  it("names the class an error result falls under", () => {
    assert.equal(MCP_ERROR_RESULT_CLASS, "mcp_error_result");
    assert.equal(typeof SlateMcpListingSummaries, "function");
  });
});

describe("running an MCP call through the backend", () => {
  it("has its own timeouts and its own error", () => {
    assert.equal(LIST_TOOLS_TIMEOUT_MS, 60_000);
    assert.equal(new SlateBackendMcpExecError("failed").message, "failed");
  });
});

describe("maintaining a session's files", () => {
  it("names the repair it is at", () => {
    assert.equal(typeof HIDDEN_ENTRY_REPAIR_VERSION, "number");
  });
});
