import assert from "node:assert/strict";
import { describe, it } from "node:test";

import {
  createSlateInferenceSessionInteropAdapter,
  toSlateInferenceBackendSessionOptions,
  videoAttachmentFeatureEnabled,
  VIDEO_ATTACHMENT_FEATURE_GATE,
  type SlateInferenceBackendSessionOptions,
} from "../../source/adapters/interop/inference/slate-inference-session-adapter.ts";
import type { SlateInferenceSessionRequest } from "../../source/host/extensions/inference/slate-inference-session.ts";

const credentials = {
  getAccessToken: async ({ backendUrl }: { backendUrl: string }) => `token:${backendUrl}`,
  getMachineId: () => "machine-1",
};

const sessionRequest: SlateInferenceSessionRequest = {
  requestedModel: { modelId: "slate-model", maxMode: true, parameters: [{ id: "effort", value: "high" }] },
  onRequestId: () => {},
  inferenceReason: { event: "review" },
  lineage: { parentRequestId: "request-parent", rootParentRequestId: "request-root", parentAgentToolCallId: "tool-call" },
};

describe("inference session interop", () => {
  it("adapts Slate session selection, auth and lineage to the backend bridge", async () => {
    const options = toSlateInferenceBackendSessionOptions(credentials, sessionRequest);
    assert.deepEqual(options.requestedModel, sessionRequest.requestedModel);
    assert.equal(options.onRequestId, sessionRequest.onRequestId);
    assert.deepEqual(options.inferenceReason, sessionRequest.inferenceReason);
    assert.deepEqual(options.lineage, sessionRequest.lineage);
    assert.equal(await options.getAccessToken({ backendUrl: "https://backend.test" }), "token:https://backend.test");
    assert.equal(await options.getMachineId(), "machine-1");
  });

  it("keeps privacy, media, session and labeling services behind its port", async () => {
    const received: SlateInferenceBackendSessionOptions[] = [];
    const media = { createUpload: () => "upload" };
    const labeling = {
      recordFollowupClassification: async () => undefined,
      recordPostTurnLabeling: async () => undefined,
    };
    const adapter = createSlateInferenceSessionInteropAdapter(credentials, {
      resolvePrivacyMode: () => "safe",
      createAttachedMediaUrlProvider: () => media,
      createPromptSession: (options) => {
        received.push(options);
        return { getModelId: () => options.requestedModel.modelId, getExecutor: () => ({} as never) };
      },
      createLabelingClient: () => labeling,
    });

    assert.equal(await adapter.resolvePrivacyMode(), "safe");
    assert.equal(adapter.createAttachedMediaUrlProvider(), media);
    assert.equal(adapter.createAttachedMediaUrlProvider(), media);
    assert.equal(adapter.createLabelingClient(), labeling);
    assert.equal(adapter.createPromptSession(sessionRequest).getModelId(), "slate-model");
    assert.equal(received.length, 1);
    assert.deepEqual(received[0]?.requestedModel, sessionRequest.requestedModel);
    assert.equal(received[0]?.onRequestId, sessionRequest.onRequestId);
    assert.deepEqual(received[0]?.inferenceReason, sessionRequest.inferenceReason);
    assert.deepEqual(received[0]?.lineage, sessionRequest.lineage);
  });

  it("reads the external video feature gate at the adapter boundary", () => {
    const inspected: string[] = [];
    assert.equal(videoAttachmentFeatureEnabled((name) => {
      inspected.push(name);
      return name === VIDEO_ATTACHMENT_FEATURE_GATE;
    }), true);
    assert.deepEqual(inspected, ["gemini_video_developer_api"]);
  });
});
