import { test } from "node:test"
import assert from "node:assert/strict"

import { AgentMode } from "../../source/adapters/interop/proto/generated/agent/v1/agent_pb.ts"
import {
  fromInteropAgentMode,
  processModeSystemReminderFromInterop,
  processModeSystemReminderWithInteropConfig,
  renderInteropMultitaskModeEnterUserReminder,
  resolveCurrentStepModeFromInterop,
  resolveCurrentTurnModeFromInterop,
  toInteropAgentMode,
} from "../../source/adapters/interop/agent/mode-processing-adapter.ts"
import { SlateMode, type ModeProcessingConfig } from "../../source/packages/agent/mode-processing.ts"

test("the mode adapter round-trips Slate's named modes to the wire enum", () => {
  const pairs = [
    [AgentMode.AGENT, SlateMode.AGENT],
    [AgentMode.ASK, SlateMode.CHAT],
    [AgentMode.PLAN, SlateMode.PLAN],
    [AgentMode.DEBUG, SlateMode.DEBUG],
    [AgentMode.TRIAGE, SlateMode.TRIAGE],
    [AgentMode.PROJECT, SlateMode.PROJECT],
    [AgentMode.MULTITASK, SlateMode.MULTITASK],
    [AgentMode.CUSTOM, SlateMode.CUSTOM],
    [AgentMode.UNSPECIFIED, SlateMode.UNSPECIFIED],
  ] as const

  for (const [wireMode, slateMode] of pairs) {
    assert.equal(fromInteropAgentMode(wireMode), slateMode)
    assert.equal(toInteropAgentMode(slateMode), wireMode)
  }
})

test("an unrecognized wire mode becomes Slate's unspecified mode", () => {
  assert.equal(fromInteropAgentMode(987654 as AgentMode), SlateMode.UNSPECIFIED)
})

test("wire-facing turn and step decisions delegate to the Slate mode policy", () => {
  assert.equal(resolveCurrentTurnModeFromInterop(AgentMode.PLAN, AgentMode.AGENT), AgentMode.AGENT)
  assert.equal(resolveCurrentStepModeFromInterop(AgentMode.PLAN, AgentMode.AGENT), AgentMode.PLAN)
  assert.equal(resolveCurrentTurnModeFromInterop(undefined, undefined), AgentMode.AGENT)
})

test("the reminder adapter passes Slate modes to its internal policy callbacks", () => {
  const previousModes: Array<string | undefined> = []
  const config: ModeProcessingConfig = {
    planSystemReminderGenerator: (previousMode) => {
      previousModes.push(previousMode)
      return "PLAN REMINDER"
    },
    askSystemReminderGenerator: () => "",
    debugSystemReminderGenerator: () => "",
    triageSystemReminderGenerator: () => "",
  }

  const reminder = processModeSystemReminderFromInterop(
    AgentMode.PLAN,
    config,
    {},
    AgentMode.AGENT,
  )

  assert.match(reminder, /PLAN REMINDER/)
  assert.deepEqual(previousModes, [SlateMode.AGENT])
})

test("Slate-mode callers reuse the policy without round-tripping through the wire enum", () => {
  const previousModes: Array<string | undefined> = []
  const config: ModeProcessingConfig = {
    planSystemReminderGenerator: (previousMode) => {
      previousModes.push(previousMode)
      return "PLAN REMINDER"
    },
    askSystemReminderGenerator: () => "",
    debugSystemReminderGenerator: () => "",
    triageSystemReminderGenerator: () => "",
  }

  const reminder = processModeSystemReminderWithInteropConfig(
    SlateMode.PLAN,
    config,
    {},
    SlateMode.AGENT,
  )

  assert.match(reminder, /PLAN REMINDER/)
  assert.deepEqual(previousModes, [SlateMode.AGENT])
})

test("the model adapter projects only Slate multitask policy into the reminder", () => {
  const reminder = renderInteropMultitaskModeEnterUserReminder({
    promptVersion: "latest",
    isComposer1: true,
    isComposer2: true,
    isGpt5: true,
  })

  assert.match(reminder, /mcp_task tool/)
  assert.match(reminder, /send every tool-based task to a background worker/)
  assert.match(reminder, /stop after delegation even when general turn guidance says to keep working until completion/)
})
