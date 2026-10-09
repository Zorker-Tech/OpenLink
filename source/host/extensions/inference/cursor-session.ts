/**
 * The inference sessions the host runs turns with.
 *
 * A session is built for the model the turn asked for — a saved selection, an environment override, the experiment the
 * account is in, or one of the platform's own subagent models — and only turns that are not a summarization or a
 * subagent carry the follow-up labeling a finished turn leaves behind. A mock response can stand in for the model
 * entirely: either as one scripted answer or as a sequence of tool calls, so a turn can be driven without inference.
 */

import { join } from "node:path";

import type { InferenceReason } from "../../../packages/proto/generated/aiserver/v1/inference_pb.ts";
import { createMockPromptExecutor } from "../../../packages/chat-inference/mock-prompt-executor.ts";
import type { SummarizationPromptSession } from "../../../packages/agent-summarization/summarization-handler.ts";
import { SLATE_COMPUTER_USE_MODEL_SELECTION, SLATE_COMPUTER_USE_SUBAGENT_MODEL_ID, isSlateAgentModelSelection, type SlateAgentModelSelection } from "../../../shared/agents/slate-agent-model.ts";
import { createCursorInferencePromptSession, createSlateAttachedMediaUrlProvider, resolveSlateRunPrivacyMode, type RequestLineage } from "../../../shared/node/cursor-backend/cursor-inference.ts";
import { SlateSettingsStore } from "../../../shared/node/settings/slate-settings-store.ts";
import { getSlateRootDir } from "../../host-paths.ts";
import { createProviderPromptSession } from "./provider-session.ts";
import { selectSlateExperimentTurnModel } from "./slate-model-experiment.ts";
import { createSlateLabelingClient, recordSlatePostTurnLabeling, wrapPromptSessionWithSlateFollowupLabeling, type LabelMessage, type LabelingClient, type PromptExecutor } from "./slate-labeling.ts";

export const SLATE_DEFAULT_MODEL_ID = "slate-4.5";
export const SLATE_DEFAULT_MODEL_SELECTION: SlateAgentModelSelection = { modelId: SLATE_DEFAULT_MODEL_ID, maxMode: true, parameters: [{ id: "effort", value: "high" }, { id: "fast", value: "true" }] };

/** The model a turn runs on, as the platform's own client takes it. */
export interface RequestedModel {
  modelId: string;
  maxMode?: boolean;
  parameters?: readonly { id: string; value: string }[];
}

export interface SlateSessionOptions {
  modelId?: string;
  isSummarizationSession?: boolean;
  isComputerUseSubagent?: boolean;
  isBrowserUseSubagent?: boolean;
}

/** A saved selection, as the client takes it: the parameters belong to the caller that saved them. */
function requestedFromSelection(selection: SlateAgentModelSelection): RequestedModel {
  return { modelId: selection.modelId, maxMode: selection.maxMode, parameters: selection.parameters.map((parameter) => ({ ...parameter })) };
}

/** A subagent's model runs in max mode and carries nothing else. */
function requestedSubagent(modelId: string): RequestedModel {
  return { modelId, maxMode: true };
}

export interface RequestedModelInputs {
  sessionOptions?: SlateSessionOptions;
  envModelOverride?: string;
  storedDefaultModel?: SlateAgentModelSelection;
  storedComputerUseModel?: unknown;
  storedBrowserUseModel?: unknown;
  experimentModelOverride?: SlateAgentModelSelection;
}

/**
 * Which model a turn runs on: what the session was opened for first (a subagent's own model, or the platform's
 * computer-use one), then what the host was told to use, and the saved selection last.
 */
export function resolveSlateRequestedModel(inputs: RequestedModelInputs): RequestedModel {
  const { sessionOptions, envModelOverride, storedDefaultModel } = inputs;
  const effectiveDefault = inputs.experimentModelOverride ?? storedDefaultModel;
  const effectiveDefaultId = envModelOverride ?? effectiveDefault?.modelId ?? SLATE_DEFAULT_MODEL_ID;
  const subagentModelId = sessionOptions?.modelId;
  const computerUse = isSlateAgentModelSelection(inputs.storedComputerUseModel) ? inputs.storedComputerUseModel : null;
  const browserUse = isSlateAgentModelSelection(inputs.storedBrowserUseModel) ? inputs.storedBrowserUseModel : null;
  if (sessionOptions?.isSummarizationSession === true && subagentModelId != null) return requestedSubagent(subagentModelId);
  if (sessionOptions?.isComputerUseSubagent === true) return requestedFromSelection(computerUse ?? { ...SLATE_COMPUTER_USE_MODEL_SELECTION, modelId: SLATE_COMPUTER_USE_SUBAGENT_MODEL_ID });
  if (sessionOptions?.isBrowserUseSubagent === true && browserUse != null) return requestedFromSelection(browserUse);
  // A session that asked for a model of its own gets that one, and one that asked for the default gets the default.
  if (subagentModelId != null && subagentModelId !== effectiveDefaultId) return requestedSubagent(subagentModelId);
  if (envModelOverride != null) return { modelId: envModelOverride };
  return requestedFromSelection(effectiveDefault ?? SLATE_DEFAULT_MODEL_SELECTION);
}

export interface SlateMockToolCall {
  readonly toolCallId?: string;
  readonly toolName: string;
  readonly args: Readonly<Record<string, unknown>>;
}

export interface SlateMockScript {
  readonly toolCalls: readonly SlateMockToolCall[];
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value != null && typeof value === "object" && !Array.isArray(value);
}

/** A scripted stand-in for the model: one message, or the tool calls it was told to make. */
export function parseSlateMockScript(raw: string): SlateMockScript | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw) as unknown;
  } catch {
    return null;
  }
  if (!isRecord(parsed)) return null;
  if (typeof parsed.sendMessage === "string" && parsed.sendMessage.length > 0) {
    return { toolCalls: [{ toolName: "SendMessage", args: { type: "text", content: parsed.sendMessage } }] };
  }
  if (!Array.isArray(parsed.toolCalls) || parsed.toolCalls.length === 0) return null;
  const toolCalls: SlateMockToolCall[] = [];
  for (const value of parsed.toolCalls) {
    if (!isRecord(value)) return null;
    if (typeof value.toolName !== "string" || value.toolName.length === 0 || !isRecord(value.args)) return null;
    if (value.toolCallId !== undefined && (typeof value.toolCallId !== "string" || value.toolCallId.length === 0)) return null;
    toolCalls.push({ ...(typeof value.toolCallId === "string" ? { toolCallId: value.toolCallId } : {}), toolName: value.toolName, args: value.args });
  }
  return { toolCalls };
}

/** A session that answers with the script, one call per turn, and says nothing once the script ran out. */
export function createScriptedMockSession(script: SlateMockScript, modelId: string): { getExecutor(): PromptExecutor; getModelId(): string } {
  let callIndex = 0;
  const executor = createMockPromptExecutor(() => {
    const call = script.toolCalls[callIndex];
    callIndex += 1;
    return call === undefined
      ? { response: "", toolCalls: [] }
      : { response: "", toolCalls: [{ toolCallId: call.toolCallId ?? `mock-tool-${callIndex}`, toolName: call.toolName, args: call.args }] };
  });
  return { getExecutor: () => executor, getModelId: () => modelId };
}

export interface CursorPromptSession {
  getModelId(): string;
  getExecutor(state?: unknown): PromptExecutor;
}

export interface CursorSessionOptions extends SlateSessionOptions {
  requestSource?: string;
  inferenceReason?: InferenceReason;
  lineage?: RequestLineage;
  skipLabeling?: boolean;
}

export interface CursorSlateInferenceOptions {
  getAccessToken(...args: unknown[]): Promise<string>;
  getMachineId(): string;
  isGeminiVideoDeveloperApiEnabled?(): boolean;
  getDefaultModel?(): SlateAgentModelSelection | undefined;
  getComputerUseModel?(): unknown;
  getBrowserUseModel?(): unknown;
  getModelExperimentState?(): Parameters<typeof selectSlateExperimentTurnModel>[0]["state"];
  getConfiguredDefaultModel?(): SlateAgentModelSelection | undefined;
  getConfiguredAutomationsModel?(): SlateAgentModelSelection | undefined;
}

export interface CursorSlateInference {
  resolvePrivacyMode(): Promise<unknown> | unknown;
  getGeminiVideoAttachedMediaUrlProvider(): unknown | undefined;
  createSession(onRequestId: (requestId: string) => void, sessionOptions?: CursorSessionOptions): CursorPromptSession | ReturnType<typeof createScriptedMockSession> | { getModelId(): string; getExecutor(): PromptExecutor };
  createSummarizationSession?(onRequestId: (requestId: string) => void, sessionOptions?: CursorSessionOptions): SummarizationPromptSession;
  recordPostTurnLabeling(args: { conversationId: string; requestId: string; modelName: string; messages: readonly LabelMessage[] }): void;
}

export function createCursorSlateInference(options: CursorSlateInferenceOptions): CursorSlateInference {
  let labelingClient: LabelingClient | undefined;
  const auth = { getAccessToken: options.getAccessToken, getMachineId: options.getMachineId };
  const attachedMedia = createSlateAttachedMediaUrlProvider(auth);
  const getLabelingClient = (): LabelingClient => (labelingClient ??= createSlateLabelingClient(auth));

  const createMockSession = (mockResponse: string, sessionOptions?: CursorSessionOptions): CursorPromptSession | ReturnType<typeof createScriptedMockSession> => {
    const modelId = sessionOptions?.modelId ?? "slate-mock";
    const script = parseSlateMockScript(mockResponse);
    if (script != null) return createScriptedMockSession(script, modelId);
    return { getExecutor: () => createMockPromptExecutor(() => ({ response: mockResponse, chunkSize: 8 })), getModelId: () => modelId };
  };

  return {
    resolvePrivacyMode: () => resolveSlateRunPrivacyMode(auth),
    getGeminiVideoAttachedMediaUrlProvider: () => (options.isGeminiVideoDeveloperApiEnabled?.() === true ? attachedMedia : undefined),
    createSession(onRequestId, sessionOptions) {
      const mockResponse = process.env.SLATE_AGENT_MOCK_RESPONSE;
      if (mockResponse != null) return createMockSession(mockResponse, sessionOptions);
      // The account decides which provider runs the turn; only the platform's own goes through the backend session.
      const routedProvider = new SlateSettingsStore(join(getSlateRootDir(), "settings.json")).getInferenceProvider();
      if (routedProvider !== "slate") return createProviderPromptSession(routedProvider) as unknown as CursorPromptSession;
      const experimentState = options.getModelExperimentState?.();
      const requestSource = sessionOptions?.requestSource;
      const experimentModelOverride = selectSlateExperimentTurnModel({
        ...(experimentState === undefined ? {} : { state: experimentState }),
        ...(requestSource === undefined ? {} : { requestSource }),
        readConfiguredDefaultModel: () => options.getConfiguredDefaultModel?.(),
        readConfiguredAutomationsModel: () => options.getConfiguredAutomationsModel?.(),
      });
      const storedDefaultModel = options.getDefaultModel?.();
      const storedComputerUseModel = options.getComputerUseModel?.();
      const storedBrowserUseModel = options.getBrowserUseModel?.();
      const requestedModel = resolveSlateRequestedModel({
        ...(sessionOptions == null ? {} : { sessionOptions }),
        ...(process.env.SLATE_AGENT_MODEL == null ? {} : { envModelOverride: process.env.SLATE_AGENT_MODEL }),
        ...(storedDefaultModel == null ? {} : { storedDefaultModel }),
        ...(storedComputerUseModel === undefined ? {} : { storedComputerUseModel }),
        ...(storedBrowserUseModel === undefined ? {} : { storedBrowserUseModel }),
        ...(experimentModelOverride == null ? {} : { experimentModelOverride }),
      });
      const session = createCursorInferencePromptSession({
        getAccessToken: options.getAccessToken,
        getMachineId: options.getMachineId,
        requestedModel,
        onRequestId,
        // The reason a turn was made is only sent when the video API is on, and only when the turn named one.
        ...(options.isGeminiVideoDeveloperApiEnabled?.() === true && sessionOptions?.inferenceReason != null ? { inferenceReason: sessionOptions.inferenceReason } : {}),
        ...(sessionOptions?.lineage == null ? {} : { lineage: sessionOptions.lineage }),
      });
      // A summarization or a subagent turn leaves nothing to label: it is not a turn the account asked for.
      const skipLabeling = sessionOptions?.skipLabeling === true || sessionOptions?.isSummarizationSession === true || sessionOptions?.isComputerUseSubagent === true;
      return skipLabeling ? session : wrapPromptSessionWithSlateFollowupLabeling(session, getLabelingClient(), requestedModel.modelId);
    },
    createSummarizationSession(onRequestId, sessionOptions) {
      return this.createSession(onRequestId, { ...(sessionOptions ?? {}), isSummarizationSession: true }) as SummarizationPromptSession;
    },
    recordPostTurnLabeling: (args) => recordSlatePostTurnLabeling(getLabelingClient(), args),
  };
}
