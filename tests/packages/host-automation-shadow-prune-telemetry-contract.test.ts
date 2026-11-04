import assert from "node:assert/strict"
import test from "node:test"

import {
  AUTOMATION_SHADOW_PRUNE_EVENT,
  automationShadowPruneTelemetry,
} from "../../source/host/telemetry/automation-shadow-prune-telemetry.ts"

const base = {
  outcome: "pruned",
  conversationId: "conversation-1",
  automationId: "automation-2",
  localDefinitionState: "present",
  localDefinitionCount: 4,
  desiredCount: 3,
  remoteShadowCount: 5,
}

test("shadow-prune telemetry maps the stable event fields and string counters", () => {
  assert.equal(AUTOMATION_SHADOW_PRUNE_EVENT, "slate.automation.shadow_prune")
  assert.deepEqual(automationShadowPruneTelemetry({ ...base, boxUptimeMs: 12.6 }), {
    level: "info",
    event: "slate.automation.shadow_prune",
    metadata: {
      conversation_id: "conversation-1",
      automation_id: "automation-2",
      outcome: "pruned",
      local_definition_state: "present",
      local_definition_count: "4",
      desired_count: "3",
      remote_shadow_count: "5",
      box_uptime_ms: "12.6",
    },
  })
})

test("failed prunes warn and a missing uptime remains an undefined metadata value", () => {
  const failed = automationShadowPruneTelemetry({ ...base, outcome: "failed", boxUptimeMs: null })
  assert.equal(failed.level, "warn")
  assert.deepEqual(failed.metadata, {
    conversation_id: "conversation-1",
    automation_id: "automation-2",
    outcome: "failed",
    local_definition_state: "present",
    local_definition_count: "4",
    desired_count: "3",
    remote_shadow_count: "5",
    box_uptime_ms: undefined,
  })
})
