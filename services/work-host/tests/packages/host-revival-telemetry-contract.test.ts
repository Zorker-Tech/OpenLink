import assert from "node:assert/strict"
import test from "node:test"
import {
  SHELL_REVIVAL_EVENT,
  shellRevivalTelemetry,
  SUBAGENT_REVIVAL_EVENT,
  subagentRevivalTelemetry,
} from "../../source/host/telemetry/revival-telemetry-mappers.ts"

test("subagent revival severity distinguishes expected deletion from other dropped work", () => {
  assert.equal(subagentRevivalTelemetry({ outcome: "dropped", reason: "agent_deleted" }).level, "info")
  assert.equal(subagentRevivalTelemetry({ outcome: "dropped", reason: "no_runner" }).level, "warn")
  assert.equal(subagentRevivalTelemetry({ outcome: "delivered", reason: "error" }).level, "info")
})

test("subagent telemetry keeps its own event and stringifies optional zero and false values", () => {
  const result = subagentRevivalTelemetry({
    parentAgentId: "parent-1",
    outcome: "delivered",
    completionCount: 0,
    subagentType: "reviewer",
    subagentAgentId: "child-1",
    reason: "finished",
    sentMessageCount: 0,
    isQuietOrigin: false,
    unregisteredValue: "must be ignored",
  })

  assert.equal(result.event, SUBAGENT_REVIVAL_EVENT)
  assert.deepEqual(result.metadata, {
    conversation_id: "parent-1",
    outcome: "delivered",
    completion_count: "0",
    subagent_type: "reviewer",
    subagent_agent_id: "child-1",
    reason: "finished",
    sent_message_count: "0",
    quiet_origin: "false",
  })
})

test("shell revival exempts a gone agent but warns on other dropped outcomes", () => {
  assert.equal(shellRevivalTelemetry({ outcome: "dropped", reason: "agent_gone" }).level, "info")
  assert.equal(shellRevivalTelemetry({ outcome: "dropped", reason: "no_runner" }).level, "warn")
  assert.equal(shellRevivalTelemetry({ outcome: "delivered", reason: "anything" }).level, "info")
})

test("shell telemetry emits only its documented fields and optional values", () => {
  const result = shellRevivalTelemetry({
    conversationId: "conversation-1",
    outcome: "delivered",
    completionCount: 2,
    sentMessageCount: null,
    isQuietOrigin: true,
    reason: undefined,
    unexpected: 99,
  })

  assert.equal(result.event, SHELL_REVIVAL_EVENT)
  assert.deepEqual(result.metadata, {
    conversation_id: "conversation-1",
    outcome: "delivered",
    completion_count: "2",
    sent_message_count: undefined,
    quiet_origin: "true",
    reason: undefined,
  })
})
