import assert from "node:assert/strict"
import { test } from "node:test"

import {
  cappedCount,
  CONVERSATION_GC_EVENT,
  conversationGcLevel,
  conversationGcTelemetry,
} from "../../source/host/telemetry/conversation-gc-telemetry.ts"

test("event severity follows the cleanup outcome and remaining size", () => {
  assert.equal(conversationGcLevel({ outcome: "failed", trigger: "startup", agentId: "a" }), "warn")
  assert.equal(conversationGcLevel({ outcome: "skipped", trigger: "startup", agentId: "a", skipReason: "unresolved-refs" }), "warn")
  assert.equal(conversationGcLevel({ outcome: "skipped", trigger: "startup", agentId: "a", skipReason: "disabled" }), "info")
  assert.equal(conversationGcLevel({ outcome: "collected", trigger: "startup", agentId: "a", stillOverCap: true, deletedRows: 1, deletedBytes: 1, liveRows: 1, liveBytes: 1, vacuumed: false }), "warn")
  assert.equal(conversationGcLevel({ outcome: "collected", trigger: "startup", agentId: "a", stillOverCap: false, deletedRows: 1, deletedBytes: 1, liveRows: 1, liveBytes: 1, vacuumed: true }), "info")
})

test("counts are rounded and bounded before they become telemetry strings", () => {
  assert.equal(cappedCount(1.6), "2")
  assert.equal(cappedCount(-4), "0")
  assert.equal(cappedCount(Number.MAX_SAFE_INTEGER + 100), String(Number.MAX_SAFE_INTEGER))
  assert.equal(cappedCount(Infinity), String(Number.MAX_SAFE_INTEGER))
})

test("a skipped cleanup reports only skip-specific values", () => {
  const event = conversationGcTelemetry({
    outcome: "skipped",
    trigger: "turn_gate",
    agentId: "agent-a",
    skipReason: "unresolved-refs",
    unresolvedProtoRefs: 2.4,
  })
  assert.equal(event.event, CONVERSATION_GC_EVENT)
  assert.equal(event.level, "warn")
  assert.deepEqual(event.metadata, {
    trigger: "turn_gate",
    outcome: "skipped",
    agent_id: "agent-a",
    skip_reason: "unresolved-refs",
    unresolved_proto_refs: "2",
    deleted_rows: undefined,
    deleted_bytes: undefined,
    live_rows: undefined,
    live_bytes: undefined,
    vacuumed: undefined,
  })
  assert.equal(JSON.stringify(event.metadata).includes("deleted_rows"), false)
})

test("a completed cleanup reports bounded counts and its vacuum result", () => {
  const event = conversationGcTelemetry({
    outcome: "collected",
    trigger: "scheduled",
    agentId: "agent-b",
    stillOverCap: false,
    deletedRows: 2.5,
    deletedBytes: -1,
    liveRows: Number.MAX_SAFE_INTEGER + 1,
    liveBytes: 512,
    vacuumed: false,
  })
  assert.equal(event.level, "info")
  assert.deepEqual(event.metadata, {
    trigger: "scheduled",
    outcome: "collected",
    agent_id: "agent-b",
    skip_reason: undefined,
    unresolved_proto_refs: undefined,
    deleted_rows: "3",
    deleted_bytes: "0",
    live_rows: String(Number.MAX_SAFE_INTEGER),
    live_bytes: "512",
    vacuumed: "false",
  })
})
