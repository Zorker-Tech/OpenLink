/**
 * The host's runtime records, second group: the session diagnostics, what a conversation collection
 * reports, the union of live work and the pending-wake ledger, the shared-room wire shapes, and what an
 * agent's records may say.
 */

import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { sessionDiagnosticTelemetry, SESSION_EVENT_BY_FAMILY, SESSION_WARN_KINDS } from "../../source/host/telemetry/session-diagnostic-telemetry.ts";
import { hostExtensionDiagnosticTelemetry } from "../../source/host/telemetry/host-extension-diagnostic-telemetry.ts";
import { CONVERSATION_GC_EVENT, conversationGcTelemetry } from "../../source/host/telemetry/conversation-gc-telemetry.ts";
import { LEDGER_ONLY_DETAIL, markerLabel, mergeAsyncTasks, pendingWakeMarkerToAsyncTask } from "../../source/host/transcript/async-task-union.ts";
import { MAX_INLINE_IMAGES_PER_ENTRY, normalizeInlineImages, normalizeTurnMessages } from "../../source/host/rooms/xuser-wire-normalization.ts";
import { EMPTY_SLATE_PROFILE, EMPTY_UNREAD_STATE, REQUEST_SOURCES } from "../../source/host/extensions/session/agent-db-serde.ts";
import { BRANCHED_ENTRY_FILTER_SQL, WINDOW_ENTRY_FILTER_SQL } from "../../source/host/extensions/session/agent-db-schema.ts";

describe("what a session's store reported", () => {
  it("reports under one event per family, with the kinds that are only a warning made explicit", () => {
    assert.equal(SESSION_EVENT_BY_FAMILY.store_db, "slate.session.store_db");
    assert.equal(SESSION_WARN_KINDS.has("degraded"), true);
    const warned = sessionDiagnosticTelemetry({ family: "store_db", kind: "degraded" });
    assert.equal(warned.level, "warn");
    assert.equal(warned.event, "slate.session.store_db");
    assert.equal(sessionDiagnosticTelemetry({ family: "store_db", kind: "something_else" }).level, "error");
    assert.equal(sessionDiagnosticTelemetry({ family: "not_a_family" as never, kind: "x" }).event, undefined);
  });

  it("names the extension that reported a diagnostic", () => {
    const report = hostExtensionDiagnosticTelemetry({ extension: "box_store", kind: "hydration_temp_cleanup_failed" });
    assert.notEqual(report, undefined);
    assert.equal(report?.event, "slate.box_store.diagnostic");
    assert.equal(report?.level, "warn");
    assert.equal(report?.metadata.kind, "hydration_temp_cleanup_failed");
  });

  it("reports a conversation collection with the outcome it ended at", () => {
    assert.equal(CONVERSATION_GC_EVENT, "slate.conversation.gc");
    assert.equal(conversationGcTelemetry({ outcome: "failed", trigger: "startup", agentId: "a1" }).level, "warn");
    const collected = conversationGcTelemetry({ outcome: "collected", trigger: "startup", agentId: "a1", collected: 3 } as never);
    assert.equal(collected.event, "slate.conversation.gc");
    assert.equal(collected.level, "info");
  });
});

describe("the work a transcript shows", () => {
  it("unions the live tasks with the ledger of pending wakes, and says which came from the ledger", () => {
    const marker = { kind: "shell", agentId: "a1", workId: "w1", markedAtMs: 5 } as const;
    const fromMarker = pendingWakeMarkerToAsyncTask(marker);
    assert.equal(fromMarker.id, "w1");
    assert.equal(markerLabel(marker as never).length > 0, true);
    const merged = mergeAsyncTasks([{ kind: "shell", id: "live", startedAtMs: 9 }] as never, [marker] as never);
    assert.deepEqual(merged.map((task) => task.id).sort(), ["live", "w1"]);
    assert.equal(LEDGER_ONLY_DETAIL.includes("pending-wake ledger"), true);
  });
});

describe("the shapes a shared room exchanges", () => {
  it("bounds the images a turn may carry and clamps what a guest's message says", () => {
    assert.equal(MAX_INLINE_IMAGES_PER_ENTRY, 4);
    const images = normalizeInlineImages(Array.from({ length: 6 }, (_v, index) => ({ base64: `b${index}`, mediaType: "image/png" })));
    assert.equal(images.length, MAX_INLINE_IMAGES_PER_ENTRY);
    const turn = normalizeTurnMessages([{ speakerKind: "human", speakerName: "  Kee  ", text: "  hello  " }]);
    assert.equal(turn.length, 1);
    assert.equal(turn[0]?.speakerName, "Kee");
    assert.equal(turn[0]?.text.trim(), "hello");
  });
});

describe("what an agent's records may say", () => {
  it("names the sources a turn can come from and the shape of an empty record", () => {
    assert.equal(REQUEST_SOURCES.has("turn"), true);
    assert.equal(REQUEST_SOURCES.has("background-revival"), true);
    assert.equal(REQUEST_SOURCES.has("made-up" as never), false);
    assert.deepEqual(EMPTY_SLATE_PROFILE, { description: "", avatarPath: null });
    assert.deepEqual(EMPTY_UNREAD_STATE, { lastActivityAt: 0, lastViewedAt: 0, isManuallyUnread: false, unreadCount: 0 });
  });

  it("reads a window of a transcript and a branch by what the entry says", () => {
    assert.match(WINDOW_ENTRY_FILTER_SQL, /!=\s*'tool-call'/);
    assert.match(BRANCHED_ENTRY_FILTER_SQL, /=\s*1/);
  });
});
