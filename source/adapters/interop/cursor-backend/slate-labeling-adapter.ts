import { coreMessageToProto } from "../chat-inference-proto/converters.ts";
import { InferenceService } from "../proto/generated/aiserver/v1/inference_connect.ts";
import {
  AgentFollowupCategorizationRequest,
  AgentPostTurnLabelingRequest,
} from "../proto/generated/aiserver/v1/inference_pb.ts";
import { createSlateCursorBackendClient, type SlateInferenceOptions } from "./cursor-inference.ts";
import type {
  FollowupClassificationInput,
  LabelingClient,
  PostTurnLabelingInput,
} from "../../../host/extensions/inference/slate-labeling-contracts.ts";

interface InferenceLabelingClient {
  recordAgentFollowupClassification(request: AgentFollowupCategorizationRequest): Promise<unknown>;
  recordAgentPostTurnLabeling(request: AgentPostTurnLabelingRequest): Promise<unknown>;
}

export function adaptSlateInferenceLabelingClient(client: InferenceLabelingClient): LabelingClient {
  return {
    recordFollowupClassification: (input: FollowupClassificationInput) => client.recordAgentFollowupClassification(
      new AgentFollowupCategorizationRequest({
        ...input,
        messages: input.messages.map((message) => coreMessageToProto(message)),
      }),
    ),
    recordPostTurnLabeling: (input: PostTurnLabelingInput) => client.recordAgentPostTurnLabeling(
      new AgentPostTurnLabelingRequest({
        ...input,
        messages: input.messages.map((message) => coreMessageToProto(message)),
      }),
    ),
  };
}

export function createSlateInferenceLabelingClient(options: Omit<SlateInferenceOptions, "backendUrl">): LabelingClient {
  const client = createSlateCursorBackendClient(InferenceService, options) as unknown as InferenceLabelingClient;
  return adaptSlateInferenceLabelingClient(client);
}
