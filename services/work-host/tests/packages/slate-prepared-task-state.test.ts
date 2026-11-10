import assert from "node:assert/strict"
import test from "node:test"

import { createEmptySlateSubagentConversationSnapshot } from "../../source/packages/agent/subagent-persisted-state.ts"
import { SlateMode } from "../../source/packages/agent/mode-processing.ts"
import { createSlateSubagentType, SlateSubagentKind } from "../../source/packages/agent/subagent-type.ts"
import {
  buildSlatePreparedTaskHookInput,
  createSlatePreparedTask,
  type SlatePreparedTask,
} from "../../source/packages/agent/tools/task-prepared-state.ts"

function preparedTask(overrides: Partial<SlatePreparedTask> = {}): SlatePreparedTask {
  return {
    agentId: "agent-1",
    typeName: "generalPurpose",
    type: createSlateSubagentType(SlateSubagentKind.GENERAL_PURPOSE),
    analyticsType: "generalPurpose",
    modelId: "model-1",
    isReadOnly: false,
    useChatMode: false,
    conversationSnapshot: createEmptySlateSubagentConversationSnapshot(),
    firstMessage: {
      text: "do work",
      messageId: "message-1",
      mode: SlateMode.AGENT,
      conversationStateBlobId: new Uint8Array(),
      hookContexts: [],
    },
    startingTurnCount: 0,
    requestId: "request-1",
    toolCallId: "call-1",
    isResuming: false,
    prompt: "do work",
    description: "work description",
    request: {
      description: "work description",
      prompt: "do work",
      subagentType: "generalPurpose",
      attachments: [],
      environment: undefined,
      targetMachine: { kind: "same-device" },
    },
    parentModelName: "parent-model",
    allowExecuteHook: false,
    configuredSteps: [],
    readonlyShellEnabled: false,
    toolName: "Task",
    preparedAtMs: 100n,
    ...overrides,
  }
}

test("prepared task owns mutable turn, message, request and setting lists", () => {
  const turn = new Uint8Array([1, 2])
  const messageBlobId = new Uint8Array([3, 4])
  const attachments = ["/repo/image.png"]
  const configuredSteps = ["preToolUse"]
  const labels: Record<string, string> = { region: "eu" }
  const source = preparedTask({
    conversationSnapshot: {
      ...createEmptySlateSubagentConversationSnapshot(),
      turns: [turn],
    },
    firstMessage: {
      text: "do work",
      messageId: "message-1",
      mode: SlateMode.CHAT,
      conversationStateBlobId: messageBlobId,
      hookContexts: [],
    },
    request: {
      description: "work description",
      prompt: "do work",
      subagentType: "generalPurpose",
      attachments,
      environment: "cloud",
      targetMachine: { kind: "worker-pool", labels },
    },
    configuredSteps,
  })

  const prepared = createSlatePreparedTask(source)
  turn[0] = 9
  messageBlobId[0] = 9
  attachments.push("/repo/second.png")
  configuredSteps.push("postToolUse")
  labels.region = "us"

  assert.deepEqual(prepared.conversationSnapshot.turns, [new Uint8Array([1, 2])])
  assert.deepEqual(prepared.firstMessage.conversationStateBlobId, new Uint8Array([3, 4]))
  assert.deepEqual(prepared.request.attachments, ["/repo/image.png"])
  assert.deepEqual(prepared.request.targetMachine, { kind: "worker-pool", labels: { region: "eu" } })
  assert.deepEqual(prepared.configuredSteps, ["preToolUse"])
})

test("hook input is projected from Slate task request fields", () => {
  const hookInput = buildSlatePreparedTaskHookInput({
    typeName: "browserUse",
    request: {
      description: "read the page",
      prompt: "open the report",
      model: "model-2",
      subagentType: "browserUse",
      resume: "agent-7",
      runInBackground: false,
      attachments: ["/repo/report.png"],
      environment: "cloud",
      cloudBaseBranch: "release",
      requestedRuntimeBuildId: "build-4",
      targetMachine: { kind: "cloud-machine", baseBranch: "release", environmentBuildId: "build-4" },
    },
  })

  assert.deepEqual(hookInput, {
    description: "read the page",
    prompt: "open the report",
    model: "model-2",
    resume: "agent-7",
    environment: "cloud",
    cloud_base_branch: "release",
    cloud_requested_environment_build_id: "build-4",
    machine: { kind: "cloud-machine", baseBranch: "release", environmentBuildId: "build-4" },
    subagent_type: "browserUse",
    run_in_background: false,
    file_attachments: ["/repo/report.png"],
  })
})

test("hook input without a prepared request leaves unknown fields absent", () => {
  const hookInput = buildSlatePreparedTaskHookInput({ typeName: "explore" })
  assert.equal(hookInput.subagent_type, "explore")
  assert.equal(hookInput.prompt, undefined)
  assert.equal(hookInput.environment, undefined)
  assert.equal(hookInput.file_attachments, undefined)
})
