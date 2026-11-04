import { test } from "node:test"
import assert from "node:assert/strict"

import { AgentMode } from "../../source/adapters/interop/proto/generated/agent/v1/agent_pb.ts"
import { createContext } from "../../source/packages/context/context.ts"
import { AgentType } from "../../source/packages/agent/utils/agent-config.ts"
import {
  isProjectConversationModeFromInterop,
  isRootProjectUserMessageFromInterop,
  resolveProjectConversationContextFromInterop,
  shouldOmitCloudWorkerProcedureFromInterop,
} from "../../source/adapters/interop/agent/project-conversation-adapter.ts"

test("the project adapter owns wire markers for root and related conversations", () => {
  assert.equal(isRootProjectUserMessageFromInterop({ projectDetails: {} }), true)
  assert.equal(isRootProjectUserMessageFromInterop({ projectDetails: {}, bestOfNGroupId: "group" }), false)
  assert.equal(isRootProjectUserMessageFromInterop({ projectDetails: { subagent: {} } }), false)
  assert.equal(isRootProjectUserMessageFromInterop({ projectDetails: { sideChat: {} } }), false)
  assert.equal(isRootProjectUserMessageFromInterop({}), false)
})

test("the adapter translates persisted mode before applying Slate's cloud-worker policy", () => {
  const common = {
    gateEnabled: true,
    agentType: AgentType.BACKGROUND,
    useLocalAgentPrompting: false,
    isNamedAgentSession: false,
    isRootProject: true,
  }
  assert.equal(shouldOmitCloudWorkerProcedureFromInterop({ ...common, mode: AgentMode.AGENT }), true)
  assert.equal(shouldOmitCloudWorkerProcedureFromInterop({ ...common, mode: AgentMode.ASK }), false)
  assert.equal(isProjectConversationModeFromInterop(AgentMode.PROJECT), true)
  assert.equal(isProjectConversationModeFromInterop(AgentMode.AGENT), false)
})

test("the adapted resolver crosses simulated turns and stops at a real user turn", async () => {
  const turnOf = (userMessage: unknown) =>
    ({ get: async () => ({ userMessage: { get: async () => userMessage } }) }) as never

  const fromProjectRoot = await resolveProjectConversationContextFromInterop(createContext(), {
    turns: [
      turnOf({ mode: AgentMode.AGENT, projectDetails: {}, isSimulatedMsg: false }),
      turnOf({ mode: AgentMode.PLAN, isSimulatedMsg: true }),
    ],
  })
  assert.deepEqual(fromProjectRoot, {
    lastMode: AgentMode.PLAN,
    isRootProject: true,
    hasProjectBoundary: true,
  })

  const stoppedAtUserTurn = await resolveProjectConversationContextFromInterop(createContext(), {
    turns: [
      turnOf({ mode: AgentMode.AGENT, projectDetails: {}, isSimulatedMsg: false }),
      turnOf({ mode: AgentMode.ASK, isSimulatedMsg: false }),
    ],
  })
  assert.deepEqual(stoppedAtUserTurn, {
    lastMode: AgentMode.ASK,
    isRootProject: false,
    hasProjectBoundary: false,
  })
})
