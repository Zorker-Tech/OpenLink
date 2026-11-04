import assert from "node:assert/strict"
import test from "node:test"

import { createTurnAgentComposition } from "../../source/host/runner/turn-agent-composition.ts"
import { buildSlateSubagentConfigsForRun, type TurnSubagentConfigHost } from "../../source/host/runner/turn-subagent-configs.ts"

function policyHost(overrides: Partial<TurnSubagentConfigHost> = {}): TurnSubagentConfigHost {
  return {
    isSubagentRunner: false,
    isSystemPromptOverridden: false,
    toolHost: { remoteBoxHasDesktop: false, getRemoteBoxAvailable: () => false },
    ...overrides,
  }
}

test("a subagent run has no child configurations and does not load the parent catalogue", () => {
  let catalogueReads = 0
  const configs = buildSlateSubagentConfigsForRun(policyHost({
    isSubagentRunner: true,
    getSubagentConfigs: () => (catalogueReads += 1, [{ name: "ignored" }]),
  }))

  assert.equal(configs, undefined)
  assert.equal(catalogueReads, 0)
})

test("box subagent configurations follow desktop availability and browser policy", () => {
  const desktop = buildSlateSubagentConfigsForRun(policyHost({
    toolHost: { remoteBoxHasDesktop: true, getRemoteBoxAvailable: () => true },
  }))
  const browser = buildSlateSubagentConfigsForRun(policyHost({
    toolHost: { remoteBoxHasDesktop: true, getRemoteBoxAvailable: () => true },
    isBrowserUseSubagentEnabled: () => true,
  }))
  const offline = buildSlateSubagentConfigsForRun(policyHost({
    toolHost: { remoteBoxHasDesktop: true, getRemoteBoxAvailable: () => false },
    isBrowserUseSubagentEnabled: () => true,
  }))

  assert.equal(desktop?.length, 1)
  assert.equal(browser?.length, 2)
  assert.deepEqual(offline, [])
})

test("multitask replaces the general-purpose slot without mutating the host catalogue", () => {
  const ordinary = { name: "ordinary" }
  const general = { name: "general" }
  const original = [ordinary, general]
  const configs = buildSlateSubagentConfigsForRun(policyHost({
    getSubagentConfigs: () => original,
    getSubagentTypeName: config => config === general ? "generalPurpose" : undefined,
    isMultitaskEnabled: () => true,
  }))

  assert.equal(configs?.length, 2)
  assert.equal(configs?.[0], ordinary)
  assert.notEqual(configs?.[1], general)
  assert.deepEqual(original, [ordinary, general])
})

test("an overridden system prompt keeps the host's general-purpose subagent", () => {
  const general = { name: "general" }
  const configs = buildSlateSubagentConfigsForRun(policyHost({
    isSystemPromptOverridden: true,
    getSubagentConfigs: () => [general],
    getSubagentTypeName: () => "generalPurpose",
    isMultitaskEnabled: () => true,
  }))

  assert.deepEqual(configs, [general])
})

test("the composition publishes the most recently built run catalogue", () => {
  const composition = createTurnAgentComposition({
    isSubagentRunner: false,
    isSharedRoomRunner: false,
    isBoxScopedSubagent: false,
    toolHost: {
      remoteBoxHasDesktop: false,
      getRemoteBoxAvailable: () => false,
      factories: {},
    },
    getSubagentConfigs: () => [{ name: "general" }],
  } as never)

  const built = composition.buildSubagentConfigsForRun()
  assert.equal(composition.getSubagentConfigsForRun(), built)
})
