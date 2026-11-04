import type { InferenceReason } from "../proto/generated/aiserver/v1/inference_pb.ts";
import {
  createCursorInferencePromptSession,
  createSlateAttachedMediaUrlProvider,
  resolveSlateRunPrivacyMode,
  type RequestLineage,
  type SlateInferenceOptions,
} from "../cursor-backend/cursor-inference.ts";
import { createSlateInferenceLabelingClient } from "../cursor-backend/slate-labeling-adapter.ts";
import type { LabelingClient } from "../../../host/extensions/inference/slate-labeling-contracts.ts";
import type {
  SlateInferenceSessionInteropPort,
  SlateInferenceSessionRequest,
  SlatePromptSession,
} from "../../../host/extensions/inference/slate-inference-session.ts";

export const VIDEO_ATTACHMENT_FEATURE_GATE = "gemini_video_developer_api";

export function videoAttachmentFeatureEnabled(checkFeatureGate: (name: string) => boolean): boolean {
  return checkFeatureGate(VIDEO_ATTACHMENT_FEATURE_GATE);
}

export interface SlateInferenceCredentials {
  readonly getAccessToken: (options: { readonly backendUrl: string }) => Promise<string>;
  readonly getMachineId: () => Promise<string> | string;
}

export type SlateInferenceBackendSessionOptions = Parameters<typeof createCursorInferencePromptSession>[0];

export interface SlateInferenceAdapterFactories {
  readonly resolvePrivacyMode?: (options: Omit<SlateInferenceOptions, "backendUrl">) => Promise<unknown> | unknown;
  readonly createAttachedMediaUrlProvider?: (options: Omit<SlateInferenceOptions, "backendUrl">) => unknown;
  readonly createPromptSession?: (options: SlateInferenceBackendSessionOptions) => SlatePromptSession;
  readonly createLabelingClient?: (options: Omit<SlateInferenceOptions, "backendUrl">) => LabelingClient;
}

function backendCredentials(credentials: SlateInferenceCredentials): Omit<SlateInferenceOptions, "backendUrl"> {
  return {
    getAccessToken: credentials.getAccessToken,
    getMachineId: async () => await credentials.getMachineId(),
  };
}

/** Maps a Slate session request onto the counterpart service input at the inference boundary. */
export function toSlateInferenceBackendSessionOptions(
  credentials: SlateInferenceCredentials,
  request: SlateInferenceSessionRequest,
): SlateInferenceBackendSessionOptions {
  return {
    ...backendCredentials(credentials),
    requestedModel: request.requestedModel,
    onRequestId: request.onRequestId,
    ...(request.inferenceReason == null ? {} : { inferenceReason: request.inferenceReason as InferenceReason }),
    ...(request.lineage === undefined ? {} : { lineage: request.lineage as RequestLineage }),
  };
}

/** Implements the Slate-owned session port using the generated inference and labeling services. */
export function createSlateInferenceSessionInteropAdapter(
  credentials: SlateInferenceCredentials,
  factories: SlateInferenceAdapterFactories = {},
): SlateInferenceSessionInteropPort {
  const backend = backendCredentials(credentials);
  const media = (factories.createAttachedMediaUrlProvider ?? createSlateAttachedMediaUrlProvider)(backend);
  const privacyMode = factories.resolvePrivacyMode ?? resolveSlateRunPrivacyMode;
  const promptSession = factories.createPromptSession ?? createCursorInferencePromptSession;
  const labelingClient = factories.createLabelingClient ?? createSlateInferenceLabelingClient;
  return {
    resolvePrivacyMode: () => privacyMode(backend),
    createAttachedMediaUrlProvider: () => media,
    createPromptSession: (request) => promptSession(toSlateInferenceBackendSessionOptions(credentials, request)),
    createLabelingClient: () => labelingClient(backend),
  };
}
