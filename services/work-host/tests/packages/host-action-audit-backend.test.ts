/**
 * The audit events that go to the backend: what each recorded action becomes on the wire, including how counts and
 * durations are rounded and what a batch with nothing in it does.
 */

import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { createSlateAuditBatchSender, toProtoAuditEventData } from "../../source/host/extensions/action-audit/action-audit-backend.ts";
import type { AuditEvent } from "../../source/host/extensions/action-audit/action-audit-service.ts";

const base = { eventId: "event-1", occurredAtMs: 1_700_000_000_123, agentId: "agent-1", turnId: "turn-1", boxId: "box-1" };

describe("a recorded action on the wire", () => {
  it("carries the event it belongs to, and the action the backend names it by", () => {
    const event = toProtoAuditEventData({ ...base, action: { kind: "mcpToolCall", toolCallId: "call-1", serverIdentifier: "srv", serverName: "Server", toolName: "read", transport: "stdio", status: "ok", durationMs: 12.6 } });
    assert.deepEqual([event.eventId, event.occurredAtMs, event.agentId, event.turnId, event.boxId], ["event-1", 1_700_000_000_123n, "agent-1", "turn-1", "box-1"]);
    assert.equal(event.action.case, "mcpToolCall");
    const action = event.action.value as { toolCallId: string; serverIdentifier: string; serverName: string; toolName: string; status: string; durationMs: bigint };
    assert.deepEqual([action.toolCallId, action.serverIdentifier, action.serverName, action.toolName, action.status, action.durationMs], ["call-1", "srv", "Server", "read", "ok", 13n]);
  });

  it("answers for a shell command with what it was blocked for only when it was blocked", () => {
    const blocked = toProtoAuditEventData({ ...base, action: { kind: "shellCommand", command: "rm -rf /", shellKind: "bash", target: "/", allowed: false, blockedReason: "dangerous", classificationReasons: ["rm"] } });
    const allowed = toProtoAuditEventData({ ...base, action: { kind: "shellCommand", command: "ls", shellKind: "bash", target: ".", allowed: true, blockedReason: "was blocked once", classificationReasons: [] } });
    const blockedAction = blocked.action.value as { allowed: boolean; blockedReason: string; classificationReasons: string[] };
    const allowedAction = allowed.action.value as { allowed: boolean; blockedReason: string };
    assert.deepEqual([blocked.action.case, blockedAction.allowed, blockedAction.blockedReason, blockedAction.classificationReasons], ["shellCommand", false, "dangerous", ["rm"]]);
    assert.deepEqual([allowedAction.allowed, allowedAction.blockedReason], [true, ""]);
    // A command nobody said anything about is a command that was allowed.
    const unstated = toProtoAuditEventData({ ...base, action: { kind: "shellCommand", command: "ls", shellKind: "bash", target: "." } });
    assert.equal((unstated.action.value as { allowed: boolean }).allowed, true);
  });

  it("carries a navigation and a computer-use session, with the counts the backend takes", () => {
    const navigation = toProtoAuditEventData({ ...base, action: { kind: "browserNavigation", url: "https://example.test", pageTitle: "Example" } });
    assert.deepEqual([navigation.action.case, (navigation.action.value as { url: string; pageTitle: string }).url], ["browserNavigation", "https://example.test"]);
    const session = toProtoAuditEventData({ ...base, action: { kind: "computerUseSession", actionCount: 3.4, actionCounts: { click: 2.5, scroll: -1 }, durationMs: -5, screenshotCount: 1 } });
    const value = session.action.value as { toolCallId: string; actionCount: bigint; actionCounts: Record<string, bigint>; durationMs: bigint; screenshotCount: bigint };
    assert.deepEqual([session.action.case, value.toolCallId], ["computerUseSession", ""]);
    assert.deepEqual([value.actionCount, value.actionCounts["click"], value.actionCounts["scroll"], value.durationMs, value.screenshotCount], [3n, 3n, 0n, 0n, 1n]);
    const named = toProtoAuditEventData({ ...base, action: { kind: "computerUseSession", toolCallId: "call-9", actionCount: 0, actionCounts: {}, durationMs: 0, screenshotCount: 0 } });
    assert.equal((named.action.value as { toolCallId: string }).toolCallId, "call-9");
  });
});

describe("sending audit events to the backend", () => {
  it("does not make a request for a batch with nothing in it", async () => {
    const sender = createSlateAuditBatchSender({ getAccessToken: async () => "token", getMachineId: async () => "machine" });
    // Nothing to send is not a reason to reach the backend at all — and no network is available here, so a request
    // would be noticed.
    await sender([]);
  });
});
