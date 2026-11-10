import assert from "node:assert/strict"
import { test } from "node:test"

import {
  SLATE_AUTOMATION_LATE_FIRE_THRESHOLD_MS,
  projectDroppedAutomationFire,
  projectAutomationRunTelemetry,
} from "../../source/host/telemetry/automation-fire-telemetry.ts"

test("run telemetry marks success as informational until the late-fire boundary", () => {
  assert.equal(SLATE_AUTOMATION_LATE_FIRE_THRESHOLD_MS, 300_000)
  const onTime = projectAutomationRunTelemetry({
    conversationId: "agent-1",
    automationId: "routine-1",
    trigger: "schedule",
    outcome: "ok",
    isGroup: false,
    durationMs: 42,
    latenessMs: 299_999,
    scheduledForMs: 0,
    sentMessageCount: 0,
    eventBatchSize: 3,
  })
  assert.equal(onTime.level, "info")
  assert.deepEqual(onTime.metadata, {
    conversation_id: "agent-1",
    automation_id: "routine-1",
    trigger: "schedule",
    outcome: "ok",
    is_group: "false",
    duration_ms: "42",
    lateness_ms: "299999",
    scheduled_for_ms: "0",
    late: "false",
    sent_message_count: "0",
    event_batch_size: "3",
  })

  assert.equal(projectAutomationRunTelemetry({
    conversationId: "agent-1",
    automationId: "routine-1",
    trigger: "schedule",
    outcome: "ok",
    isGroup: false,
    durationMs: 42,
    latenessMs: 300_000,
  }).level, "warn")
})

test("dropped-fire telemetry preserves explicit zeroes and marks absent optional details", () => {
  const report = projectDroppedAutomationFire({
    conversationId: "agent-2",
    trigger: "event",
    reason: "disabled",
    scheduledForMs: 0,
    latenessMs: 0,
    errorType: "PolicyError",
    errorCode: "SLATE-E0001",
    runUuid: "run-1",
    fireAgeMs: 0,
    hasDefinitionRevision: false,
    boxUptimeMs: 0,
  })

  assert.equal(report.level, "warn")
  assert.deepEqual(report.metadata, {
    conversation_id: "agent-2",
    trigger: "event",
    reason: "disabled",
    scheduled_for_ms: "0",
    lateness_ms: "0",
    error_type: "PolicyError",
    error_code: "SLATE-E0001",
    run_uuid: "run-1",
    fire_age_ms: "0",
    has_definition_revision: "false",
    box_uptime_ms: "0",
  })
})
