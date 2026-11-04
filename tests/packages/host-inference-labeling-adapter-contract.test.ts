import assert from "node:assert/strict";
import { describe, it } from "node:test";

import {
  AgentFollowupCategorizationRequest,
  AgentPostTurnLabelingRequest,
} from "../../source/adapters/interop/proto/generated/aiserver/v1/inference_pb.ts";
import { adaptSlateInferenceLabelingClient } from "../../source/adapters/interop/cursor-backend/slate-labeling-adapter.ts";

describe("Slate inference labeling wire adapter", () => {
  it("projects host follow-up values into the backend request and returns its answer", async () => {
    const requests: unknown[] = [];
    const client = adaptSlateInferenceLabelingClient({
      recordAgentFollowupClassification: async (request) => { requests.push(request); return "accepted"; },
      recordAgentPostTurnLabeling: async () => "ignored",
    });
    const answer = await client.recordFollowupClassification({
      requestId: "req-2",
      replyingToRequestId: "req-1",
      messages: [{ role: "user", content: "hello" }],
      conversationId: "conversation-1",
      agentMode: "slate-agent",
      modelName: "model-a",
    });
    const request = requests[0] as AgentFollowupCategorizationRequest;
    assert.equal(answer, "accepted");
    assert.equal(request instanceof AgentFollowupCategorizationRequest, true);
    assert.deepEqual([
      request.requestId,
      request.replyingToRequestId,
      request.conversationId,
      request.agentMode,
      request.modelName,
      request.messages.length,
    ], ["req-2", "req-1", "conversation-1", "slate-agent", "model-a", 1]);
  });

  it("projects post-turn values into their own backend message without hiding rejection", async () => {
    const requests: unknown[] = [];
    const client = adaptSlateInferenceLabelingClient({
      recordAgentFollowupClassification: async () => "ignored",
      recordAgentPostTurnLabeling: async (request) => { requests.push(request); throw new Error("backend refused"); },
    });
    await assert.rejects(() => client.recordPostTurnLabeling({
      requestId: "req-3",
      messages: [{ role: "assistant", content: "done" }],
      conversationId: "conversation-1",
      agentMode: "slate-agent",
      modelName: "model-b",
    }), /backend refused/);
    const request = requests[0] as AgentPostTurnLabelingRequest;
    assert.equal(request instanceof AgentPostTurnLabelingRequest, true);
    assert.deepEqual([request.requestId, request.conversationId, request.agentMode, request.modelName, request.messages.length], [
      "req-3", "conversation-1", "slate-agent", "model-b", 1,
    ]);
  });
});
