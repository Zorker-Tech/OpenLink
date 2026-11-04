/**
 * The host's runtime pieces, eighth group: what leaves the host for a shared room, how a transcript entry
 * is named, whether several tasks may run at once, the trays a user sees, and how far the host got in
 * starting up.
 */

import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { parseRemoteAgentId, REMOTE_AGENT_ID_PREFIX, SLATE_SHARED_ROOM_IMAGE_BYTES_MAX } from "../../source/host/rooms/xuser-entry-publisher.ts";
import { INITIAL_TRANSCRIPT_TURN_KEY, allocateTranscriptEntryId } from "../../source/host/transcript/transcript-entry-ids.ts";
import { EXECUTOR_SUBAGENT_TYPE, resolveMultitaskEnabled } from "../../source/host/slate-multitask.ts";
import { MAX_TRAYS, TrayManager } from "../../source/host/notifications/trays/trays-service.ts";
import { SlateLocalExecPathError } from "../../source/host/local-exec/local-exec-machine.ts";
import { SLATE_HOST_LIFECYCLE_PHASES } from "../../source/host/telemetry/host-lifecycle-progress.ts";
import { SEARCH_INDEX_FILENAME, SEARCH_INDEX_SCHEMA_VERSION } from "../../source/host/extensions/content-search/search-index-db.ts";

describe("what leaves the host for a shared room", () => {
  it("parses a remote agent's id from the prefix the platform uses", () => {
    assert.equal(REMOTE_AGENT_ID_PREFIX, "slate-remote:");
    assert.deepEqual(parseRemoteAgentId("slate-remote:owner-1/agent-2"), { ownerAuthId: "owner-1", agentId: "agent-2" });
    assert.equal(parseRemoteAgentId("agent-2"), null);
    assert.equal(parseRemoteAgentId("slate-remote:onlyowner"), null);
    assert.equal(SLATE_SHARED_ROOM_IMAGE_BYTES_MAX, 1_100_000);
  });
});

describe("how a transcript entry is named", () => {
  it("says what it is and where it belongs, and never names the same thing twice", () => {
    assert.equal(INITIAL_TRANSCRIPT_TURN_KEY, "b");
    assert.equal(allocateTranscriptEntryId([], "assistant-message"), "tba0");
    const first = allocateTranscriptEntryId([{ id: "tba0", kind: "assistant-message" }] as never, "assistant-message");
    assert.notEqual(first, "tba0");
    assert.equal(allocateTranscriptEntryId([{ id: "b1", kind: "user-message", turnId: "b" }] as never, "user-message").startsWith("t"), true);
  });
});

describe("whether several tasks may run at once", () => {
  it("takes the environment override first and the check second", () => {
    assert.equal(EXECUTOR_SUBAGENT_TYPE, "executor");
    assert.equal(resolveMultitaskEnabled("1", () => false), true);
    assert.equal(resolveMultitaskEnabled("0", () => true), false);
    assert.equal(resolveMultitaskEnabled(undefined, () => true), true);
    assert.equal(resolveMultitaskEnabled(undefined, () => false), false);
  });
});

describe("the trays a user sees", () => {
  it("keeps them bounded and lets a reader see what is there", () => {
    assert.equal(MAX_TRAYS, 20);
    const trays = new TrayManager();
    assert.deepEqual(trays.getTrays(), []);
    trays.pushError({ agentId: "a1", title: "Something failed", detail: "because", requestId: "r1" } as never);
    assert.equal(trays.getTrays().length, 1);
    const seen = trays.getTrays();
    trays.subscribe(() => {});
    assert.equal(Array.isArray(seen), true);
    trays.clearAll();
    assert.deepEqual(trays.getTrays(), []);
  });
});

describe("what the local-exec daemon may touch", () => {
  it("names the error a refused path raises", () => {
    const error = new SlateLocalExecPathError("outside");
    assert.equal(error instanceof SlateLocalExecPathError, true);
    assert.equal(error instanceof Error, true);
    assert.equal(error.message, "outside");
  });
});

describe("how far the host got in starting up", () => {
  it("walks the phases the platform names, in order", () => {
    assert.deepEqual([...SLATE_HOST_LIFECYCLE_PHASES], ["plugin_graph", "identity", "log_catchup", "transcript_read", "ready"]);
  });
});

describe("the content search's own index", () => {
  it("is a database of its own, written as the version it was created with", () => {
    assert.equal(SEARCH_INDEX_FILENAME, "search-index.db");
    assert.equal(SEARCH_INDEX_SCHEMA_VERSION, 1);
  });
});
