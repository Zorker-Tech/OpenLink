import assert from "node:assert/strict"
import { test } from "node:test"

import { AgentType } from "../../source/packages/agent/utils/agent-config.ts"
import { canUseWatchVideoSubagent } from "../../source/packages/agent/context/watch-video-eligibility.ts"

test("IDE sessions need their dedicated literal-true flag", () => {
  assert.equal(canUseWatchVideoSubagent({ agentType: AgentType.IDE, backgroundAgentSource: undefined }), false)
  assert.equal(canUseWatchVideoSubagent({
    agentType: AgentType.IDE,
    backgroundAgentSource: "other",
    featureFlags: { enableWatchVideoInIdeSubagent: true },
  }), true)
  assert.equal(canUseWatchVideoSubagent({
    agentType: AgentType.IDE,
    backgroundAgentSource: "chat",
    featureFlags: { enableBackgroundVideoAttachments: true },
  }), false)
})

test("background chat and automation sessions need the shared video-attachment flag", () => {
  for (const backgroundAgentSource of ["chat", "automation"] as const) {
    assert.equal(canUseWatchVideoSubagent({
      agentType: AgentType.BACKGROUND,
      backgroundAgentSource,
      featureFlags: { enableBackgroundVideoAttachments: true },
    }), true)
    assert.equal(canUseWatchVideoSubagent({
      agentType: AgentType.BACKGROUND,
      backgroundAgentSource,
      featureFlags: { enableBackgroundVideoAttachments: false },
    }), false)
  }
  assert.equal(canUseWatchVideoSubagent({
    agentType: AgentType.BACKGROUND,
    backgroundAgentSource: "other",
    featureFlags: { enableBackgroundVideoAttachments: true },
  }), false)
  assert.equal(canUseWatchVideoSubagent({
    agentType: AgentType.BACKGROUND,
    backgroundAgentSource: undefined,
    featureFlags: { enableBackgroundVideoAttachments: true },
  }), false)
})

test("other agent types and non-boolean flag values never enable video watching", () => {
  for (const agentType of [AgentType.CLI, AgentType.BUGBOT, undefined]) {
    assert.equal(canUseWatchVideoSubagent({
      agentType,
      backgroundAgentSource: "chat",
      featureFlags: {
        enableBackgroundVideoAttachments: true,
        enableWatchVideoInIdeSubagent: true,
      },
    }), false)
  }
  assert.equal(canUseWatchVideoSubagent({
    agentType: AgentType.BACKGROUND,
    backgroundAgentSource: "chat",
    featureFlags: { enableBackgroundVideoAttachments: "true" as unknown as boolean },
  }), false)
})
