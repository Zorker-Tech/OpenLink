import assert from "node:assert/strict"
import { describe, it } from "node:test"

import { AgentMode } from "../../source/adapters/interop/proto/generated/agent/v1/agent_pb.ts"
import { createContext } from "../../source/packages/context/context.ts"
import { isProjectWorkspaceConversation } from "../../source/packages/agent/configs/project-workspace-mcp-tools.ts"
import { SlateMode } from "../../source/packages/agent/mode-processing.ts"

function turnOf(userMessage: unknown) {
  return {
    get: async () => ({ userMessage: { get: async () => userMessage } }),
  }
}

describe("project workspace MCP policy", () => {
  it("short-circuits for project mode and requires history for other modes", async () => {
    let turnsRead = 0
    const projectMode = {
      mode: SlateMode.PROJECT,
      get turns() {
        turnsRead += 1
        throw new Error("project mode should not read conversation turns")
      },
    }
    assert.equal(await isProjectWorkspaceConversation(createContext(), projectMode as never), true)
    assert.equal(turnsRead, 0)
    assert.equal(await isProjectWorkspaceConversation(createContext(), { mode: SlateMode.AGENT }), false)
    assert.equal(await isProjectWorkspaceConversation(createContext(), { mode: SlateMode.AGENT, turns: [] }), false)
  })

  it("uses the interop root boundary when the current mode is not project", async () => {
    const rootProject = await isProjectWorkspaceConversation(createContext(), {
      mode: SlateMode.AGENT,
      turns: [turnOf({ mode: AgentMode.AGENT, projectDetails: {}, isSimulatedMsg: false })],
    } as never)
    const related = await isProjectWorkspaceConversation(createContext(), {
      mode: SlateMode.AGENT,
      turns: [turnOf({ mode: AgentMode.AGENT, projectDetails: { sideChat: {} }, isSimulatedMsg: false })],
    } as never)

    assert.equal(rootProject, true)
    assert.equal(related, false)
  })
})
