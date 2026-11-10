/** Slate-owned model selection, mock sessions, and session lifecycle for host inference. */

import { join } from "node:path";

import { createMockPromptExecutor } from "../../../packages/chat-inference/mock-prompt-executor.ts";
import type { SummarizationPromptSession } from "../../../packages/agent-summarization/summarization-handler.ts";
import { SLATE_COMPUTER_USE_MODEL_SELECTION, SLATE_COMPUTER_USE_SUBAGENT_MODEL_ID, isSlateAgentModelSelection, type SlateAgentModelSelection } from "../../../shared/agents/slate-agent-model.ts";
import { SlateSettingsStore } from "../../../shared/node/settings/slate-settings-store.ts";
import { getSlateRootDir } from "../../host-paths.ts";
import { createProviderPromptSession } from "./provider-session.ts";
import { selectSlateExperimentTurnModel } from "./slate-model-experiment.ts";
import { recordSlatePostTurnLabeling, wrapPromptSessionWithSlateFollowupLabeling, type LabelMessage, type LabelingClient, type PromptExecutor } from "./slate-labeling.ts";

export const SLATE_DEFAULT_MODEL_ID = "slate-4.5";
export const SLATE_DEFAULT_MODEL_SELECTION: SlateAgentModelSelection = {
  modelId: SLATE_DEFAULT_MODEL_ID,
  maxMode: true,
  parameters: [{ id: "effort", value: "high" }, { id: "fast", value: "true" }],
};

export interface RequestedModel {
  readonly modelId: string;
  readonly maxMode?: boolean;
  readonly parameters?: readonly { readonly id: string; readonly value: string }[];
}

export interface SlateInferenceRequestLineage {
  readonly parentRequestId: string;
  readonly rootParentRequestId: string;
  readonly parentAgentToolCallId?: string;
}

export interface SlateInferenceSessionOptions {
  readonly modelId?: string;
  readonly isSummarizationSession?: boolean;
  readonly isComputerUseSubagent?: boolean;
  readonly isBrowserUseSubagent?: boolean;
  readonly requestSource?: string;
  readonly inferenceReason?: unknown;
  readonly lineage?: SlateInferenceRequestLineage;
  readonly skipLabeling?: boolean;
}

export interface RequestedModelInputs {
  readonly sessionOptions?: SlateInferenceSessionOptions;
  readonly envModelOverride?: string;
  readonly storedDefaultModel?: SlateAgentModelSelection;
  readonly storedComputerUseModel?: unknown;
  readonly storedBrowserUseModel?: unknown;
  readonly experimentModelOverride?: SlateAgentModelSelection;
}

export interface SlatePromptSession {
  getModelId(): string;
  getExecutor(state?: unknown): PromptExecutor;
}

export interface SlateInferenceSessionRequest {
  readonly requestedModel: RequestedModel;
  readonly onRequestId: (requestId: string) => void;
  readonly inferenceReason?: unknown;
  readonly lineage?: SlateInferenceRequestLineage;
}

/** Ports implemented at the cloud-service boundary; the session policy does not interpret their wire shapes. */
export interface SlateInferenceSessionInteropPort {
  resolvePrivacyMode(): Promise<unknown> | unknown;
  createAttachedMediaUrlProvider(): unknown;
  createPromptSession(request: SlateInferenceSessionRequest): SlatePromptSession;
  createLabelingClient(): LabelingClient;
}

export interface SlateInferenceSessionFactoryOptions {
  readonly interop: SlateInferenceSessionInteropPort;
  readonly isVideoAttachmentEnabled?: () => boolean;
  readonly getDefaultModel?: () => SlateAgentModelSelection | undefined;
  readonly getComputerUseModel?: () => unknown;
  readonly getBrowserUseModel?: () => unknown;
  readonly getModelExperimentState?: () => Parameters<typeof selectSlateExperimentTurnModel>[0]["state"];
  readonly getConfiguredDefaultModel?: () => SlateAgentModelSelection | undefined;
  readonly getConfiguredAutomationsModel?: () => SlateAgentModelSelection | undefined;
}

export interface SlateInferenceSessionFactory {
  resolvePrivacyMode(): Promise<unknown> | unknown;
  getAttachedMediaUrlProvider(): unknown | undefined;
  createSession(onRequestId: (requestId: string) => void, options?: SlateInferenceSessionOptions): SlatePromptSession;
  createSummarizationSession(onRequestId: (requestId: string) => void, options?: SlateInferenceSessionOptions): SummarizationPromptSession;
  recordPostTurnLabeling(args: { conversationId: string; requestId: string; modelName: string; messages: readonly LabelMessage[] }): void;
}

/** A saved selection is copied so the turn never follows later edits to its source record. */
function copySelection(selection: SlateAgentModelSelection): RequestedModel {
  return {
    modelId: selection.modelId,
    maxMode: selection.maxMode,
    parameters: selection.parameters.map(({ id, value }) => ({ id, value })),
  };
}

/** A subagent's explicit model runs in max mode without inheriting the caller's parameters. */
function subagentModel(modelId: string): RequestedModel {
  return { modelId, maxMode: true };
}

/** Chooses the model requested for this turn, with an explicit subagent selection taking precedence. */
export function resolveSlateRequestedModel(inputs: RequestedModelInputs): RequestedModel {
  const { sessionOptions, envModelOverride, storedDefaultModel } = inputs;
  const defaultSelection = inputs.experimentModelOverride ?? storedDefaultModel;
  const defaultModelId = envModelOverride ?? defaultSelection?.modelId ?? SLATE_DEFAULT_MODEL_ID;
  const explicitModelId = sessionOptions?.modelId;
  const computerSelection = isSlateAgentModelSelection(inputs.storedComputerUseModel) ? inputs.storedComputerUseModel : undefined;
  const browserSelection = isSlateAgentModelSelection(inputs.storedBrowserUseModel) ? inputs.storedBrowserUseModel : undefined;

  if (sessionOptions?.isSummarizationSession === true && explicitModelId != null) return subagentModel(explicitModelId);
  if (sessionOptions?.isComputerUseSubagent === true) {
    return copySelection(computerSelection ?? { ...SLATE_COMPUTER_USE_MODEL_SELECTION, modelId: SLATE_COMPUTER_USE_SUBAGENT_MODEL_ID });
  }
  if (sessionOptions?.isBrowserUseSubagent === true && browserSelection !== undefined) return copySelection(browserSelection);
  if (explicitModelId != null && explicitModelId !== defaultModelId) return subagentModel(explicitModelId);
  if (envModelOverride != null) return { modelId: envModelOverride };
  return copySelection(defaultSelection ?? SLATE_DEFAULT_MODEL_SELECTION);
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

/** Parses a mock response as one assistant message or as a finite sequence of tool calls. */
export function parseSlateMockScript(raw: string): SlateMockScript | null {
  let value: unknown;
  try {
    value = JSON.parse(raw) as unknown;
  } catch {
    return null;
  }
  if (!isRecord(value)) return null;
  if (typeof value.sendMessage === "string" && value.sendMessage.length > 0) {
    return { toolCalls: [{ toolName: "SendMessage", args: { type: "text", content: value.sendMessage } }] };
  }
  if (!Array.isArray(value.toolCalls) || value.toolCalls.length === 0) return null;
  const toolCalls: SlateMockToolCall[] = [];
  for (const item of value.toolCalls) {
    if (!isRecord(item) || typeof item.toolName !== "string" || item.toolName.length === 0 || !isRecord(item.args)) return null;
    if (item.toolCallId !== undefined && (typeof item.toolCallId !== "string" || item.toolCallId.length === 0)) return null;
    toolCalls.push({
      ...(typeof item.toolCallId === "string" ? { toolCallId: item.toolCallId } : {}),
      toolName: item.toolName,
      args: item.args,
    });
  }
  return { toolCalls };
}

/** A mock session returns each scripted call once, then produces an empty answer. */
export function createScriptedMockSession(script: SlateMockScript, modelId: string): SlatePromptSession {
  let nextCallIndex = 0;
  const executor = createMockPromptExecutor(() => {
    const call = script.toolCalls[nextCallIndex];
    nextCallIndex += 1;
    return call === undefined
      ? { response: "", toolCalls: [] }
      : { response: "", toolCalls: [{ toolCallId: call.toolCallId ?? `mock-tool-${nextCallIndex}`, toolName: call.toolName, args: call.args }] };
  });
  return { getExecutor: () => executor, getModelId: () => modelId };
}

/** Builds the session factory from Slate-owned model settings and interop ports. */
export function createSlateInferenceSessionFactory(options: SlateInferenceSessionFactoryOptions): SlateInferenceSessionFactory {
  let labelingClient: LabelingClient | undefined;
  const getLabelingClient = () => (labelingClient ??= options.interop.createLabelingClient());

  const createMockSession = (mockResponse: string, sessionOptions?: SlateInferenceSessionOptions): SlatePromptSession => {
    const modelId = sessionOptions?.modelId ?? "slate-mock";
    const script = parseSlateMockScript(mockResponse);
    return script === null
      ? { getExecutor: () => createMockPromptExecutor(() => ({ response: mockResponse, chunkSize: 8 })), getModelId: () => modelId }
      : createScriptedMockSession(script, modelId);
  };

  function createSession(onRequestId: (requestId: string) => void, sessionOptions?: SlateInferenceSessionOptions): SlatePromptSession {
    const mockResponse = process.env.SLATE_AGENT_MOCK_RESPONSE;
    if (mockResponse != null) return createMockSession(mockResponse, sessionOptions);

    const provider = new SlateSettingsStore(join(getSlateRootDir(), "settings.json")).getInferenceProvider();
    if (provider !== "slate") return createProviderPromptSession(provider) as SlatePromptSession;

    const experimentState = options.getModelExperimentState?.();
    const experimentModelOverride = selectSlateExperimentTurnModel({
      ...(experimentState === undefined ? {} : { state: experimentState }),
      ...(sessionOptions?.requestSource === undefined ? {} : { requestSource: sessionOptions.requestSource }),
      readConfiguredDefaultModel: () => options.getConfiguredDefaultModel?.(),
      readConfiguredAutomationsModel: () => options.getConfiguredAutomationsModel?.(),
    });
    const storedDefaultModel = options.getDefaultModel?.();
    const storedComputerUseModel = options.getComputerUseModel?.();
    const storedBrowserUseModel = options.getBrowserUseModel?.();
    const requestedModel = resolveSlateRequestedModel({
      ...(sessionOptions === undefined ? {} : { sessionOptions }),
      ...(process.env.SLATE_AGENT_MODEL == null ? {} : { envModelOverride: process.env.SLATE_AGENT_MODEL }),
      ...(storedDefaultModel == null ? {} : { storedDefaultModel }),
      ...(storedComputerUseModel === undefined ? {} : { storedComputerUseModel }),
      ...(storedBrowserUseModel === undefined ? {} : { storedBrowserUseModel }),
      ...(experimentModelOverride == null ? {} : { experimentModelOverride }),
    });

    const session = options.interop.createPromptSession({
      requestedModel,
      onRequestId,
      ...(options.isVideoAttachmentEnabled?.() === true && sessionOptions?.inferenceReason != null
        ? { inferenceReason: sessionOptions.inferenceReason }
        : {}),
      ...(sessionOptions?.lineage == null ? {} : { lineage: sessionOptions.lineage }),
    });
    const skipLabeling = sessionOptions?.skipLabeling === true
      || sessionOptions?.isSummarizationSession === true
      || sessionOptions?.isComputerUseSubagent === true;
    return skipLabeling
      ? session
      : wrapPromptSessionWithSlateFollowupLabeling(session, getLabelingClient(), requestedModel.modelId);
  }

  return {
    resolvePrivacyMode: () => options.interop.resolvePrivacyMode(),
    getAttachedMediaUrlProvider: () => options.isVideoAttachmentEnabled?.() === true
      ? options.interop.createAttachedMediaUrlProvider()
      : undefined,
    createSession,
    createSummarizationSession: (onRequestId, sessionOptions) => createSession(onRequestId, {
      ...(sessionOptions ?? {}),
      isSummarizationSession: true,
    }) as SummarizationPromptSession,
    recordPostTurnLabeling: (args) => recordSlatePostTurnLabeling(getLabelingClient(), args),
  };
}
