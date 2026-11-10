import assert from "node:assert/strict"
import { describe, it } from "node:test"

import { SubagentBackgroundReason } from "../../source/adapters/interop/proto/generated/agent/v1/agent_pb.ts"
import { SubagentArgs } from "../../source/adapters/interop/proto/generated/agent/v1/subagent_exec_pb.ts"
import { createInteropSubagentExecutor } from "../../source/adapters/interop/agent/subagent-exec-adapter.ts"
import { createContext } from "../../source/packages/context/context.ts"
import type { SubagentAdapterArgs } from "../../source/host/runner/subagent-session-coordinator.ts"

describe("the subagent executor interop adapter", () => {
  it("projects the run inputs the Slate host owns and encodes the background result", async () => {
    let received: SubagentAdapterArgs | undefined
    const executor = createInteropSubagentExecutor({
      async createOrResumeSession(_context, args) {
        received = args
        return "agent-1"
      },
      async runSession(_context, _agentId, _args) {
        return {
          status: "background",
          backgroundReason: SubagentBackgroundReason.AGENT_REQUEST,
          toolCallCount: 0,
          transcriptPath: "/runs/agent-1.jsonl",
        }
      },
    })
    const result = await executor.execute(createContext(), new SubagentArgs({
      toolCallId: "call-1",
      parentConversationId: "parent-1",
      subagentType: "generalPurpose",
      prompt: "run this",
      resumeAgentId: "agent-existing",
      forkAgentId: "agent-fork",
      readonly: true,
      selectedContext: {
        selectedImages: [{ uuid: "image-1", path: "/workspace/image.png", mimeType: "image/png", dataOrBlobId: { case: "data", value: new Uint8Array([1, 2]) } }],
        selectedVideos: [{ uuid: "video-1", path: "/workspace/video.mp4", filename: "video.mp4", mimeType: "video/mp4", dataOrBlobId: { case: "data", value: new Uint8Array([3, 4]) } }],
      },
    }), {})

    assert.deepEqual(received, {
      toolCallId: "call-1",
      subagentType: "generalPurpose",
      prompt: "run this",
      resumeAgentId: "agent-existing",
      readonly: true,
      selectedContext: {
        images: [{ id: "image-1", sourcePath: "/workspace/image.png", mediaType: "image/png", content: { kind: "inline-bytes", bytes: new Uint8Array([1, 2]) } }],
        videos: [{ id: "video-1", sourcePath: "/workspace/video.mp4", displayName: "video.mp4", mediaType: "video/mp4", writeToWorkspace: false, content: { kind: "bytes", bytes: new Uint8Array([3, 4]) } }],
        commands: [],
      },
    })
    assert.equal(result.result.case, "success")
    if (result.result.case !== "success") assert.fail("expected a successful background result")
    assert.equal(result.result.value.agentId, "agent-1")
    assert.equal(result.result.value.backgroundReason, SubagentBackgroundReason.AGENT_REQUEST)
    assert.equal(result.result.value.transcriptPath, "/runs/agent-1.jsonl")
  })

  it("preserves generated error results when a host run throws", async () => {
    const executor = createInteropSubagentExecutor({
      async createOrResumeSession() { return "agent-2" },
      async runSession() { throw new Error("runner failed") },
    })
    const result = await executor.execute(createContext(), new SubagentArgs({
      toolCallId: "call-2",
      parentConversationId: "parent-1",
    }), {})
    assert.equal(result.result.case, "error")
    if (result.result.case !== "error") assert.fail("expected an error result")
    assert.equal(result.result.value.agentId, "agent-2")
    assert.equal(result.result.value.error, "runner failed")
  })

  it("keeps unknown wire enum numbers in Slate compatibility metadata and restores them at the boundary", async () => {
    let observed: unknown
    const executor = createInteropSubagentExecutor({
      async createOrResumeSession() { return "agent-3" },
      async runSession() {
        return {
          status: "background",
          backgroundReason: 97 as SubagentBackgroundReason,
          toolCallCount: 0,
        }
      },
    })
    const result = await executor.execute(createContext(), new SubagentArgs({
      toolCallId: "call-3",
      parentConversationId: "parent-1",
    }), {})
    if (result.result.case !== "success") assert.fail("expected an encoded successful result")
    observed = result.result.value.backgroundReason
    assert.equal(observed, 97)
  })
})
