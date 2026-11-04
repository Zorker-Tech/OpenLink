import assert from "node:assert/strict"
import { test } from "node:test"

import { adaptInteropCloudTestingModelProfile } from "../../source/adapters/interop/agent/testing-prompt-profile-adapter.ts"
import { AgentType } from "../../source/packages/agent/utils/agent-config.ts"
import { getCloudTestingSectionElements, getCloudTestingSectionsPlacement } from "../../source/packages/agent/prompts/cloud-testing-sections.ts"

test("the interop adapter converts the external prompt version into a Slate capability", () => {
  const model = adaptInteropCloudTestingModelProfile({
    modelName: "model-a",
    promptVersion: "cursor-0226",
    isSlateProductPrompt: true,
    isCodexFamily: true,
  })
  assert.equal(model?.modelName, "model-a")
  assert.equal(model?.usesShellLessCloudPrompt, true)
  assert.equal(model?.isSlateProductPrompt, true)
  assert.equal(model?.isCodexFamily, true)
  assert.equal("promptVersion" in (model ?? {}), false)
  assert.equal(adaptInteropCloudTestingModelProfile(undefined), undefined)
})

const eligible = {
  modelInfo: { modelName: "model-a", usesShellLessCloudPrompt: true, isSlateProductPrompt: true },
  enableComposer2IntelligentTestingPromptSection: true,
  backgroundAgentSource: "other" as const,
  agentType: AgentType.BACKGROUND,
  enableCloudTesting: true,
}

test("placement is selected only for an eligible cloud model and follows Slate placement policy", () => {
  assert.equal(getCloudTestingSectionsPlacement(eligible), "user_info")
  assert.equal(getCloudTestingSectionsPlacement({ ...eligible, featureFlags: { slateCloudTestingInSystemPrompt: true } }), "system_prompt")
  assert.equal(getCloudTestingSectionsPlacement({ ...eligible, priorUserInfoCloudTestingSectionsPlacement: "user_info", featureFlags: { slateCloudTestingInSystemPrompt: true } }), "user_info")
  assert.equal(getCloudTestingSectionsPlacement({ ...eligible, priorUserInfoCloudTestingSectionsPlacement: "system_prompt" }), "system_prompt")
  assert.equal(getCloudTestingSectionsPlacement({ ...eligible, modelInfo: { ...eligible.modelInfo, isSlateProductPrompt: false }, priorUserInfoCloudTestingSectionsPlacement: "system_prompt" }), "user_info")
  assert.equal(getCloudTestingSectionsPlacement({ ...eligible, enableCloudTesting: false }), undefined)
  assert.equal(getCloudTestingSectionsPlacement({ ...eligible, modelInfo: { ...eligible.modelInfo, usesShellLessCloudPrompt: false } }), undefined)
})

test("section construction requires context and includes only its selected elements", () => {
  const sections = getCloudTestingSectionElements({
    ...eligible,
    toolInfo: { allTools: { SHELL: { name: "RunShell" } } },
  })
  assert.ok(sections?.gitAndSubmission)
  assert.ok(sections?.testing)
  assert.equal(sections?.computerUse, undefined)
  assert.equal(getCloudTestingSectionElements({ ...eligible, useLocalAgentPrompting: true, toolInfo: { allTools: {} } }), undefined)
})
