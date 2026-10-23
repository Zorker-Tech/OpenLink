import path from "node:path"
import mimeTypesModule from "mime-types"

import { isGeminiModelId, isSignedUrlStorageAllowed, GEMINI_VIDEO_SUBAGENT_MAX_BYTES, getInlineVideoMaxBytes, getSignedUrlVideoMaxBytes, uploadAttachedMediaToSignedUrl } from "../attached-media.ts"
import type { Context } from "../../context/context.ts"
import { ConversationStateStructure, PreparedTaskSubagent, SubagentCredentials, SubagentExecutionEnvironment, TaskToolCallArgsProto } from "../../proto/generated/agent/v1/agent_pb.ts"
import type { AttachedMediaUrlProvider } from "../context/video-attachment.ts"
import { detectImageMimeType } from "./core/read/image-utils.ts"
import { requestContextExecutorResource } from "../../agent-exec/request-context-operation.ts"
import { readExecutorResource } from "../../agent-exec/read-operation.ts"
import { RequestContextArgs, type RequestContextResult } from "../../proto/generated/agent/v1/request_context_exec_pb.ts"
import { ReadArgs, type ReadResult } from "../../proto/generated/agent/v1/read_exec_pb.ts"
import type { SubagentPersistedState } from "../../proto/generated/agent/v1/agent_pb.ts"
import type { SubagentType } from "../../proto/generated/agent/v1/subagents_pb.ts"
import { SelectedContext, SelectedImage, SelectedImage_BlobIdWithData, SelectedVideo, SelectedVideo_BlobIdWithData, SelectedVideo_SignedUrl, type SelectedContext as SelectedContextValue, type SelectedCursorCommand } from "../../proto/generated/agent/v1/selected_context_pb.ts"
import type { PrivacyMode } from "../../redaction/privacy-mode.ts"
import { GENERAL_PURPOSE_SUBAGENT_TYPE, applyConversationStateMapping, getSubagentTypeName, isGeminiVideoSubagentType } from "./core/subagent/subagent-config.ts"
import { computeSubagentRequestId, generateSeededUuid } from "./tool-support.ts"
import { ToolCallArgParseError } from "./tool-errors.ts"
import { getRequestId, getRootParentRequestId } from "../utils/request-scope.ts"
import { SubagentModelForcePolicy } from "./subagent-model-policy.ts"
import {
  resolveSubagentModel,
  getEffectiveReadonlyForSubagent,
  shouldUseAskModeForSubagent,
  taskEnvironmentToProto,
  targetMachineToEnvironment,
  targetMachineFromLegacyArgs,
  targetMachineFromProto,
  targetMachineToProto,
  createUserMessageAction,
  type TaskEnvironment,
  type TaskTargetMachine,
  type TaskSubagentModelConfig,
} from "./task-runtime.ts"

interface MimeTypesModule {
  lookup(filePath: string): string | false;
}

const mimeTypes = mimeTypesModule as MimeTypesModule;


/** A blob's bytes, carried inline or as a blob id with the bytes beside it. */
function dataOrBlobId(binaryData: Uint8Array, outputBlobId: Uint8Array | undefined) {
  return outputBlobId !== undefined && outputBlobId.length > 0
    ? { case: "blobIdWithData" as const, value: { blobId: new Uint8Array(outputBlobId), data: new Uint8Array(binaryData) } }
    : { case: "data" as const, value: new Uint8Array(binaryData) };
}

/** Video attachments are a Gemini-only feature: say so before anything is read. */
function assertVideoModelSupported(resolvedModelId: string | undefined): void {
  const modelId = resolvedModelId?.trim();
  if (modelId !== undefined && modelId.length > 0 && !isGeminiModelId(modelId)) {
    throw new Error("Video attachments are only supported for Gemini models");
  }
}

export type RawTaskEnvironmentArgs = {
  readonly environment?: TaskEnvironment;
  readonly machine?: TaskTargetMachine;
};

export function protoEnvironmentToTaskEnvironment(
  environment: SubagentExecutionEnvironment,
): TaskEnvironment {
  switch (environment) {
    case SubagentExecutionEnvironment.CLOUD:
      return "cloud";
    case SubagentExecutionEnvironment.LOCAL:
      return "local";
    default:
      return undefined;
  }
}

/** Where a subagent runs: what the request asked for, or failing that what its saved state says. */
export function getEffectiveSubagentEnvironment(
  rawArgs: RawTaskEnvironmentArgs,
  restoredState: Pick<
    SubagentPersistedState,
    "machine" | "environment" | "cloudSubagent"
  > | undefined,
): SubagentExecutionEnvironment {
  if (rawArgs.machine !== undefined) {
    return targetMachineToEnvironment(rawArgs.machine);
  }
  const requestedEnvironment = taskEnvironmentToProto(rawArgs.environment);
  if (requestedEnvironment !== SubagentExecutionEnvironment.UNSPECIFIED) {
    return requestedEnvironment;
  }
  const restoredMachine = targetMachineFromProto(restoredState?.machine);
  if (restoredMachine !== undefined) {
    return targetMachineToEnvironment(restoredMachine);
  }
  if (restoredState?.environment === SubagentExecutionEnvironment.CLOUD) {
    return SubagentExecutionEnvironment.CLOUD;
  }
  if (restoredState?.environment === SubagentExecutionEnvironment.LOCAL) {
    return SubagentExecutionEnvironment.LOCAL;
  }
  if (restoredState?.cloudSubagent !== undefined) {
    return SubagentExecutionEnvironment.CLOUD;
  }
  return SubagentExecutionEnvironment.UNSPECIFIED;
}

export interface CanonicalSubagentIdResolver {
  resolveSubagentId?: (subagentIdOrBcId: string) => string | undefined;
}

/** A subagent may be named by the id it was started with or by the id of its cloud run. */
export function resolveCanonicalSubagentId(
  parentState: CanonicalSubagentIdResolver,
  subagentIdOrBcId: string,
): string {
  return parentState.resolveSubagentId?.(subagentIdOrBcId) ?? subagentIdOrBcId;
}

const VIDEO_MIME_MAP: Readonly<Record<string, string>> = {
  mp4: "video/mp4",
  webm: "video/webm",
  mov: "video/quicktime",
  avi: "video/x-msvideo",
  mkv: "video/x-matroska",
  wmv: "video/x-ms-wmv",
  flv: "video/x-flv",
  m4v: "video/x-m4v",
};

/** The video formats the platform knows by extension, for paths whose type cannot be sniffed. */
export function getVideoMimeTypeFromPath(filePath: string): string | undefined {
  const extension = filePath.split(".").pop()?.toLowerCase();
  return extension === undefined ? undefined : VIDEO_MIME_MAP[extension];
}

/** A path that might be a video, whether by its extension or by what the mime database says. */
export function getPotentialVideoMimeTypeFromPath(
  filePath: string,
): string | undefined {
  const mappedMime = getVideoMimeTypeFromPath(filePath);
  if (mappedMime !== undefined) {
    return mappedMime;
  }
  const lookupMime = mimeTypes.lookup(filePath);
  return typeof lookupMime === "string" && lookupMime.startsWith("video/")
    ? lookupMime
    : undefined;
}

export interface SubagentAttachmentPathEnvironment {
  readonly projectFolder?: string;
  readonly workspacePaths: readonly string[];
  readonly artifactsFolder?: string;
}

export interface SubagentAttachmentPathRequestContext {
  readonly env?: SubagentAttachmentPathEnvironment;
}

export function isPathWithinAllowedPrefix(args: {
  readonly targetPath: string;
  readonly prefix: string;
}): boolean {
  const resolvedTarget = path.resolve(args.targetPath);
  const resolvedPrefix = path.resolve(args.prefix);
  return (
    resolvedTarget === resolvedPrefix ||
    resolvedTarget.startsWith(resolvedPrefix + path.sep)
  );
}

/** A refused attachment says where attachments may come from, so the model can stop guessing. */
export function untrustedAttachmentPathError(attachmentPath: string): Error {
  return new Error(
    `Attachment path is not trusted: ${attachmentPath}. Only videos the user attached to this conversation, or files under this agent's own uploads/artifacts roots, can be passed in file_attachments — copying the file somewhere else, onto the user's computer especially, cannot make it trusted.`,
  );
}

/** An attachment path is trusted only where attachments actually live, or where the user put it. */
export function resolveTrustedAttachmentPath(args: {
  readonly attachmentPath: string;
  readonly requestContext: SubagentAttachmentPathRequestContext;
  readonly userAttachedVideoPaths?: readonly string[];
  readonly trustedVideoAttachmentRoots?: readonly string[];
}): string | undefined {
  const posixPath = path.posix.normalize(args.attachmentPath);
  if (
    (args.trustedVideoAttachmentRoots ?? []).some(
      (root) =>
        root.startsWith("/") &&
        root.length > 1 &&
        posixPath.startsWith(`${root}/`),
    )
  ) {
    return posixPath;
  }
  const canonicalPath = path.resolve(args.attachmentPath);
  const env = args.requestContext.env;
  const allowedPrefixes = [
    ...(env?.projectFolder !== undefined
      ? [
          path.join(env.projectFolder, "uploads"),
          path.join(env.projectFolder, "attachments"),
        ]
      : []),
    ...(env?.workspacePaths.flatMap((workspacePath) => [
      path.join(workspacePath, "uploads"),
      path.join(workspacePath, "attachments"),
    ]) ?? []),
    env?.artifactsFolder,
  ].filter((prefix): prefix is string => prefix !== undefined);
  if (
    allowedPrefixes.some((prefix) =>
      isPathWithinAllowedPrefix({ targetPath: canonicalPath, prefix }),
    )
  ) {
    return canonicalPath;
  }
  const userAttachedPaths = (args.userAttachedVideoPaths ?? []).map((attachedPath) =>
    path.resolve(attachedPath),
  );
  return userAttachedPaths.includes(canonicalPath) ? canonicalPath : undefined;
}

export interface SubagentAttachmentRequestContext {
  readonly env?: SubagentAttachmentPathEnvironment;
}

/** A session with no environment has no folders, which is the same as none being allowed. */
export function attachmentPathEnvironment(
  requestContext: SubagentAttachmentRequestContext,
): SubagentAttachmentPathEnvironment {
  return requestContext.env ?? { workspacePaths: [] };
}

interface AttachmentResourceAccessor {
  get(resource: typeof requestContextExecutorResource): {
    execute(ctx: Context, args: RequestContextArgs): Promise<RequestContextResult>;
  };
  get(resource: typeof readExecutorResource): {
    execute(
      ctx: Context,
      args: ReadArgs,
      meta: { readonly execId: string },
    ): Promise<ReadResult>;
  };
}

interface SubagentAttachmentRequestContextResult {
  readonly requestContext: SubagentAttachmentRequestContext;
}

async function fetchAttachmentTrustContext(args: {
  readonly ctx: Context;
  readonly resourceAccessor: AttachmentResourceAccessor;
}): Promise<SubagentAttachmentRequestContext> {
  const requestContextExecutor = args.resourceAccessor.get(requestContextExecutorResource);
  const requestContextResult = await requestContextExecutor.execute(
    args.ctx,
    new RequestContextArgs(),
  );
  if (
    requestContextResult.result.case !== "success" ||
    requestContextResult.result.value.requestContext === undefined
  ) {
    throw new Error("Failed to validate attachment paths");
  }
  return requestContextResult.result.value.requestContext;
}

export interface AttachmentProcessingOptions {
  readonly resolvedModelId?: string;
  readonly privacyMode?: PrivacyMode;
  readonly attachedMediaUrlProvider?: AttachedMediaUrlProvider;
  readonly conversationId?: string;
  readonly inlineVideoMaxBytes?: number;
  readonly signedUrlVideoMaxBytes?: number;
  readonly subagentType?: SubagentType;
  readonly useGeminiDeveloperVideoUpload?: boolean;
  readonly skipTrustedPathValidation?: boolean;
  readonly userAttachedVideoPaths?: readonly string[];
  readonly trustedVideoAttachmentRoots?: readonly string[];
}

export interface PreparedAttachmentContextArgs {
  readonly ctx: Context;
  readonly attachmentPaths: readonly string[];
  readonly resourceAccessor: AttachmentResourceAccessor;
  readonly toolCallId: string;
  readonly options?: AttachmentProcessingOptions;
}

/** The attachments a client-run subagent is given: images and videos, each in the form it needs. */
export async function buildClientSubagentAttachmentsContext(
  ctx: Context,
  attachmentPaths: readonly string[],
  resourceAccessor: AttachmentResourceAccessor,
  toolCallId: string,
  options?: AttachmentProcessingOptions,
): Promise<SelectedContextValue | undefined> {
  if (attachmentPaths.length === 0) {
    return undefined;
  }
  const videoPaths: string[] = [];
  const nonVideoPaths: string[] = [];
  for (const attachmentPath of attachmentPaths) {
    if (getPotentialVideoMimeTypeFromPath(attachmentPath) !== undefined) {
      videoPaths.push(attachmentPath);
    } else {
      nonVideoPaths.push(attachmentPath);
    }
  }
  const selectedContext =
    (nonVideoPaths.length > 0
      ? await collectAttachments(
          ctx,
          nonVideoPaths,
          resourceAccessor,
          toolCallId,
          options,
        )
      : undefined) ?? new SelectedContext();
  if (videoPaths.length === 0) {
    return selectedContext;
  }
  const requestContext = await fetchAttachmentTrustContext({
    ctx,
    resourceAccessor,
  });
  const resolvedModelId = options?.resolvedModelId?.trim();
  if (
    resolvedModelId !== undefined &&
    resolvedModelId.length > 0 &&
    !isGeminiModelId(resolvedModelId)
  ) {
    throw new Error("Video attachments are only supported for Gemini models");
  }
  const selectedVideos = [...selectedContext.selectedVideos];
  for (const rawFilePath of videoPaths) {
    const trustedPathArgs = {
      attachmentPath: rawFilePath,
      requestContext,
      ...(options?.userAttachedVideoPaths !== undefined
        ? { userAttachedVideoPaths: options.userAttachedVideoPaths }
        : {}),
      ...(options?.trustedVideoAttachmentRoots !== undefined
        ? { trustedVideoAttachmentRoots: options.trustedVideoAttachmentRoots }
        : {}),
    };
    const filePath = resolveTrustedAttachmentPath(trustedPathArgs);
    if (filePath === undefined) {
      throw untrustedAttachmentPathError(rawFilePath);
    }
    const mimeType = getPotentialVideoMimeTypeFromPath(filePath);
    if (mimeType === undefined) {
      throw new Error(`Could not detect mime type for attachment: ${filePath}`);
    }
    selectedVideos.push(
      new SelectedVideo({
        uuid: generateSeededUuid(`video-${toolCallId}-${filePath}`),
        path: filePath,
        mimeType,
        filename: path.basename(filePath),
        fps: 4,
      }),
    );
  }
  return new SelectedContext({ ...selectedContext, selectedVideos });
}

export interface ConversationStateParent {
  getConversationState(ctx: Context): Promise<ConversationStateStructure>;
  restoreSubagentState(
    ctx: Context,
    subagentId: string,
  ): Pick<SubagentPersistedState, "conversationState" | "cloudSubagent" | "subagentType" | "modelId" | "machine" | "environment" | "firstClassBcId" | "cloudRequestedEnvironmentBuildId"> | undefined;
}

export interface ConversationStateSubagentConfig {
  readonly conversationStateMapper?: ((
    callerState: ConversationStateStructure,
  ) => ConversationStateStructure) | undefined;
}

/** What a subagent starts from: the parent's conversation, its own saved one, or a mapped slice. */
export async function resolveSubagentConversationState(
  ctx: Context,
  subagentConfig: ConversationStateSubagentConfig,
  parentState: ConversationStateParent,
  subagentIdToResume: string | undefined,
  isSelfForkRequested: boolean,
  toolCallId: string,
  typeName: string,
): Promise<ConversationStateStructure> {
  if (isSelfForkRequested) {
    return parentState.getConversationState(ctx);
  }
  if (subagentIdToResume !== undefined) {
    const restoredState = parentState.restoreSubagentState(ctx, subagentIdToResume);
    if (restoredState?.conversationState !== undefined) {
      return restoredState.conversationState;
    }
    if (restoredState?.cloudSubagent !== undefined) {
      return new ConversationStateStructure();
    }
  }
  return applyConversationStateMapping(
    subagentConfig,
    await parentState.getConversationState(ctx),
  );
}

export interface PriorSubagentModelOptions {
  readonly isModelBlocked: (modelId: string) => boolean;
  readonly requiresMaxMode?: (modelId: string) => Promise<boolean>;
  readonly parentMaxMode: boolean;
}

/** A resumed subagent keeps its model, but only when that model can still be used. */
export async function isPriorSubagentModelUsable(
  modelId: string,
  options: PriorSubagentModelOptions,
): Promise<boolean> {
  if (options.isModelBlocked(modelId)) {
    return false;
  }
  if (options.requiresMaxMode === undefined) {
    return true;
  }
  const modelRequiresMaxMode = await options.requiresMaxMode(modelId);
  return options.parentMaxMode || !modelRequiresMaxMode;
}

export interface TaskRawArguments {
  readonly description?: string;
  readonly prompt: string;
  readonly model?: string;
  readonly resume?: string;
  readonly subagent_type?: string;
  readonly file_attachments?: readonly string[];
  readonly environment?: TaskEnvironment;
  readonly cloud_base_branch?: string;
  readonly cloud_requested_environment_build_id?: string;
  readonly machine?: TaskTargetMachine;
  readonly run_in_background?: boolean;
}

export interface TaskResolutionParentState extends ConversationStateParent {
  resolveSubagentId?: (subagentIdOrBcId: string) => string | undefined;
  getSubagentIdToResume?: (typeName: string, mode: string) => string | undefined;
}

export interface TaskResolutionMeta {
  readonly toolCallId: string;
}

export interface TaskResolutionModelInfo {
  readonly modelName: string;
}

export interface TaskResolutionOptions {
  readonly forceModelId?: string;
  readonly subagentModelForcePolicy: (typeof SubagentModelForcePolicy)[keyof typeof SubagentModelForcePolicy];
  readonly parentRequestedModelName?: string;
  readonly parentModelParameters?: readonly unknown[];
  readonly parentMaxMode: boolean;
  readonly subagentModels: import("./core/subagent/models.js").SubagentModels;
  readonly isModelBlocked: (modelId: string) => boolean;
  readonly isModelValid: (modelId: string) => boolean;
  readonly requiresMaxMode?: (modelId: string) => Promise<boolean>;
  readonly compareModelCosts: (candidateModelId: string, parentModelId: string) => number;
  readonly enableExploreParentModelInheritance?: boolean;
}

export interface TaskSubagentResolution {
  readonly subagentConfig: TaskSubagentModelConfig;
  readonly effectiveReadonly: boolean;
  readonly useAskModeForSubagent: boolean;
  readonly typeName: string;
  readonly analyticsSubagentType: string;
  readonly resolvedModelId: string;
  readonly resolvedModelParameters?: readonly unknown[] | undefined;
  readonly subagentIdToResume?: string | undefined;
  readonly subagentId: string;
  readonly isResume: boolean;
  readonly parentRequestId?: string | undefined;
  readonly rootParentRequestId?: string | undefined;
  readonly subagentRequestId: string;
  readonly isSelfForkRequested: boolean;
  readonly effectiveEnvironment: SubagentExecutionEnvironment;
  readonly effectiveTargetMachine: TaskTargetMachine;
  readonly cloudSubagentBcId?: string | undefined;
  readonly cloudRequestedEnvironmentBuildId?: string | undefined;
}

function subagentConfigNamed(
  configs: readonly TaskSubagentModelConfig[],
  name: string | undefined,
): TaskSubagentModelConfig | undefined {
  if (name === undefined) return undefined;
  const normalizedInput = name.trim().toLowerCase().replace(/[-_]/g, "");
  return configs.find(config => getSubagentTypeName(config.subagent_type).trim().toLowerCase().replace(/[-_]/g, "") === normalizedInput);
}

function resumeMeansSelf(resume: string | undefined): boolean {
  return resume?.trim().toLowerCase() === "self";
}

/** Which catalogue entry, model, placement and identity a task call resolves to. */
export async function resolveTaskSubagentConfig(args: {
  readonly ctx: Context;
  readonly rawArgs: TaskRawArguments;
  readonly meta: TaskResolutionMeta;
  readonly subagentConfigs: readonly TaskSubagentModelConfig[];
  readonly parentState: TaskResolutionParentState;
  readonly parentModelInfo: TaskResolutionModelInfo;
  readonly options: TaskResolutionOptions;
}): Promise<TaskSubagentResolution> {
  const {
    ctx: turnContext,
    rawArgs: requestArgs,
    meta: callMeta,
    subagentConfigs: catalogue,
    parentState: parent,
    parentModelInfo: parentModel,
    options: settings,
  } = args;
  const fallbackConfig = subagentConfigNamed(catalogue, GENERAL_PURPOSE_SUBAGENT_TYPE) ?? catalogue[0];
  if (fallbackConfig === undefined) throw new ToolCallArgParseError("No subagent types are available.");
  const requestedConfig = subagentConfigNamed(catalogue, requestArgs.subagent_type) ?? fallbackConfig;
  const resumeMode = requestedConfig.resumeModeOverride ?? "DEFAULT";
  const requestedType = getSubagentTypeName(requestedConfig.subagent_type);
  const requestKey = computeSubagentRequestId(callMeta.toolCallId);
  const selfForkRequested = resumeMeansSelf(requestArgs.resume);
  let resumeId: string | undefined;
  if (!selfForkRequested) {
    if (resumeMode !== "DEFAULT") resumeId = parent.getSubagentIdToResume?.(requestedType, resumeMode);
    else if (requestArgs.resume !== undefined && requestArgs.resume.length > 0) resumeId = resolveCanonicalSubagentId(parent, requestArgs.resume);
  }
  const restoredState = resumeId === undefined ? undefined : parent.restoreSubagentState(turnContext, resumeId);
  const persistedType = restoredState?.subagentType === undefined ? undefined : getSubagentTypeName(restoredState.subagentType);
  const persistedConfig = subagentConfigNamed(catalogue, persistedType);
  if (persistedType !== undefined && persistedConfig === undefined) throw new ToolCallArgParseError(`Cannot resume subagent of type "${persistedType}" because that subagent type is not available.`);
  const subagentConfig = persistedConfig ?? requestedConfig;
  const readonlyEffective = getEffectiveReadonlyForSubagent(subagentConfig);
  const askMode = shouldUseAskModeForSubagent(readonlyEffective, subagentConfig);
  const resolvedTypeName = getSubagentTypeName(subagentConfig.subagent_type);
  const analyticsType = subagentConfig.subagent_type.type.case === "custom" ? "custom" : resolvedTypeName;
  const environmentField = getEffectiveSubagentEnvironment(requestArgs, restoredState);
  const requestedMachine = requestArgs.machine ?? targetMachineFromProto(restoredState?.machine) ?? (environmentField === SubagentExecutionEnvironment.CLOUD
    ? targetMachineFromLegacyArgs({ environment: "cloud", cloud_base_branch: requestArgs.cloud_base_branch, cloud_requested_environment_build_id: requestArgs.cloud_requested_environment_build_id })
    : { type: "same_machine" });
  const priorModel = selfForkRequested ? settings.parentRequestedModelName ?? parentModel.modelName : restoredState?.modelId?.trim() || undefined;
  if (priorModel !== undefined && settings.subagentModelForcePolicy === SubagentModelForcePolicy.ParentPin && settings.forceModelId !== undefined && priorModel !== settings.forceModelId) throw new ToolCallArgParseError(`Cannot resume subagent with model "${priorModel}" because the active policy requires model "${settings.forceModelId}".`);
  const chosenModelId = priorModel ?? await resolveSubagentModel({
    subagentConfig,
    forceModelId: settings.forceModelId,
    subagentModelForcePolicy: settings.subagentModelForcePolicy,
    requestedModel: requestArgs.model,
    parentModelId: settings.parentRequestedModelName ?? parentModel.modelName,
    enableExploreParentModelInheritance: settings.enableExploreParentModelInheritance,
    parentMaxMode: settings.parentMaxMode,
    subagentModels: settings.subagentModels,
    isModelBlocked: settings.isModelBlocked,
    isModelValid: settings.isModelValid,
    requiresMaxMode: settings.requiresMaxMode,
    compareModelCosts: settings.compareModelCosts,
  });
  if (priorModel !== undefined && !await isPriorSubagentModelUsable(priorModel, settings)) throw new ToolCallArgParseError(`Cannot resume subagent with model "${priorModel}" because it is blocked or unavailable.`);
  const newSubagentId = resumeId ?? generateSeededUuid(`subagent-${resolvedTypeName}-${callMeta.toolCallId}`);
  const parentKey = getRequestId(turnContext);
  const rootParentKey = getRootParentRequestId(turnContext) ?? parentKey;
  const resumeBcId = restoredState?.cloudSubagent?.bcId?.trim() || restoredState?.firstClassBcId?.trim() || undefined;
  const buildId = requestedMachine.type === "new_cloud_vm" ? requestedMachine.environment_build_id?.trim() || requestArgs.cloud_requested_environment_build_id?.trim() || restoredState?.cloudRequestedEnvironmentBuildId?.trim() || undefined : undefined;
  const targetMachineFinal = requestedMachine.type === "new_cloud_vm" && buildId !== requestedMachine.environment_build_id
    ? { ...requestedMachine, ...(buildId !== undefined ? { environment_build_id: buildId } : {}) }
    : requestedMachine;
  const parentModelForParams = settings.parentRequestedModelName ?? parentModel.modelName;
  const modelParametersChosen = chosenModelId === parentModelForParams && (settings.parentModelParameters?.length ?? 0) > 0 ? settings.parentModelParameters : undefined;
  return {
    subagentConfig,
    effectiveReadonly: readonlyEffective,
    useAskModeForSubagent: askMode,
    typeName: resolvedTypeName,
    analyticsSubagentType: analyticsType,
    resolvedModelId: chosenModelId,
    resolvedModelParameters: modelParametersChosen,
    subagentIdToResume: resumeId,
    subagentId: newSubagentId,
    isResume: resumeId !== undefined,
    parentRequestId: parentKey,
    rootParentRequestId: rootParentKey,
    subagentRequestId: requestKey,
    isSelfForkRequested: selfForkRequested,
    effectiveEnvironment: environmentField,
    effectiveTargetMachine: targetMachineFinal,
    cloudSubagentBcId: resumeBcId,
    cloudRequestedEnvironmentBuildId: buildId,
  };
}

export interface PrepareTaskSubagentArgs {
  readonly resolved: TaskSubagentResolution;
  readonly ctx: Context;
  readonly rawArgs: TaskRawArguments;
  readonly meta: TaskResolutionMeta;
  readonly parentState: ConversationStateParent;
  readonly resourceAccessor: AttachmentResourceAccessor;
  readonly parentModelInfo: TaskResolutionModelInfo;
  readonly subagentCredentials?: SubagentCredentials["credentials"] | undefined;
  readonly enableExecuteHookExec?: boolean | undefined;
  readonly configuredSteps?: readonly string[] | undefined;
  readonly readonlyShellEnabled?: boolean | undefined;
  readonly toolName?: string | undefined;
  readonly parentCursorCommands?: readonly SelectedCursorCommand[] | undefined;
  readonly privacyMode?: PrivacyMode | undefined;
  readonly attachedMediaUrlProvider?: AttachedMediaUrlProvider | undefined;
  readonly geminiVideoAttachedMediaUrlProvider?: AttachedMediaUrlProvider | undefined;
  readonly inlineVideoMaxBytes?: number | undefined;
  readonly signedUrlVideoMaxBytes?: number | undefined;
}

/** Everything a subagent needs to start, assembled from the request and the state it resumes from. */
export async function prepareTaskSubagent(args: PrepareTaskSubagentArgs): Promise<InstanceType<typeof PreparedTaskSubagent>> {
  const { resolved, ctx, rawArgs, meta, parentState, resourceAccessor, parentModelInfo } = args;
  const {
    subagentConfig,
    typeName: resolvedTypeName,
    resolvedModelId: chosenModelId,
    subagentIdToResume: resumeId,
    subagentId: newSubagentId,
    isResume: isResumeFlag,
    isSelfForkRequested: selfForkRequested,
    useAskModeForSubagent: askMode,
    effectiveReadonly: readonlyEffective,
    analyticsSubagentType: analyticsType,
    parentRequestId: parentKey,
    rootParentRequestId: rootParentKey,
    subagentRequestId: requestKey,
    cloudSubagentBcId: resumeBcId,
    cloudRequestedEnvironmentBuildId: buildId,
  } = resolved;
  let attachmentSelection: SelectedContextValue | undefined;
  if (rawArgs.file_attachments !== undefined && rawArgs.file_attachments.length > 0) {
    const mediaProvider = isGeminiVideoSubagentType(subagentConfig.subagent_type) ? args.geminiVideoAttachedMediaUrlProvider ?? args.attachedMediaUrlProvider : args.attachedMediaUrlProvider;
    attachmentSelection = await collectAttachments(ctx, rawArgs.file_attachments, resourceAccessor, meta.toolCallId, {
      resolvedModelId: chosenModelId,
      ...(args.privacyMode !== undefined ? { privacyMode: args.privacyMode } : {}),
      ...(mediaProvider !== undefined ? { attachedMediaUrlProvider: mediaProvider } : {}),
      ...(args.inlineVideoMaxBytes !== undefined ? { inlineVideoMaxBytes: args.inlineVideoMaxBytes } : {}),
      ...(args.signedUrlVideoMaxBytes !== undefined ? { signedUrlVideoMaxBytes: args.signedUrlVideoMaxBytes } : {}),
      subagentType: subagentConfig.subagent_type,
      useGeminiDeveloperVideoUpload: isGeminiVideoSubagentType(subagentConfig.subagent_type) && args.geminiVideoAttachedMediaUrlProvider !== undefined,
      skipTrustedPathValidation: true,
    });
  }
  if (args.parentCursorCommands !== undefined && args.parentCursorCommands.length > 0) {
    attachmentSelection = attachmentSelection ?? new SelectedContext();
    attachmentSelection.cursorCommands = [...args.parentCursorCommands];
  }
  const firstAction = createUserMessageAction(subagentConfig, rawArgs.prompt, generateSeededUuid(meta.toolCallId), askMode, attachmentSelection);
  const startingState = await resolveSubagentConversationState(ctx, subagentConfig, parentState, resumeId, selfForkRequested, meta.toolCallId, resolvedTypeName);
  const persistCredentials = resolved.effectiveEnvironment !== SubagentExecutionEnvironment.CLOUD;
  return new PreparedTaskSubagent({
    subagentId: newSubagentId,
    subagentTypeName: resolvedTypeName,
    subagentType: subagentConfig.subagent_type,
    analyticsSubagentType: analyticsType,
    resolvedModelId: chosenModelId,
    effectiveReadonly: readonlyEffective,
    useAskModeForSubagent: askMode,
    conversationState: startingState,
    initialAction: firstAction,
    initialTurnsCount: startingState.turns.length,
    subagentRequestId: requestKey,
    ...(resumeBcId !== undefined ? { cloudSubagentBcId: resumeBcId } : {}),
    toolCallId: meta.toolCallId,
    isResume: isResumeFlag,
    ...(parentKey !== undefined ? { parentRequestId: parentKey } : {}),
    ...(rootParentKey !== undefined ? { rootParentRequestId: rootParentKey } : {}),
    taskPrompt: rawArgs.prompt,
    taskDescription: rawArgs.description ?? "",
    ...(attachmentSelection !== undefined ? { selectedContext: attachmentSelection } : {}),
    ...(subagentConfig.plugin !== undefined ? { plugin: subagentConfig.plugin } : {}),
    ...(subagentConfig.marketplace !== undefined ? { marketplace: subagentConfig.marketplace } : {}),
    ...(subagentConfig.pluginId !== undefined ? { pluginId: subagentConfig.pluginId } : {}),
    ...(subagentConfig.marketplaceId !== undefined ? { marketplaceId: subagentConfig.marketplaceId } : {}),
    ...(subagentConfig.subagentSource !== undefined ? { subagentSource: subagentConfig.subagentSource } : {}),
    rawArgs: new TaskToolCallArgsProto({
      description: rawArgs.description ?? "",
      prompt: rawArgs.prompt,
      ...(rawArgs.model !== undefined ? { model: rawArgs.model } : {}),
      subagentType: rawArgs.subagent_type ?? resolvedTypeName,
      ...(rawArgs.resume !== undefined ? { resume: rawArgs.resume } : {}),
      ...(rawArgs.run_in_background !== undefined ? { runInBackground: rawArgs.run_in_background } : {}),
      attachments: rawArgs.file_attachments === undefined ? [] : [...rawArgs.file_attachments],
      environment: resolved.effectiveEnvironment,
      ...((rawArgs.cloud_base_branch ?? (resolved.effectiveTargetMachine.type === "new_cloud_vm" ? resolved.effectiveTargetMachine.base_branch : undefined)) !== undefined ? { cloudBaseBranch: rawArgs.cloud_base_branch ?? (resolved.effectiveTargetMachine.type === "new_cloud_vm" ? resolved.effectiveTargetMachine.base_branch : "") } : {}),
      ...(buildId !== undefined ? { cloudRequestedEnvironmentBuildId: buildId } : {}),
      machine: targetMachineToProto(resolved.effectiveTargetMachine),
    }),
    parentModelName: parentModelInfo.modelName,
    ...(args.subagentCredentials !== undefined && persistCredentials ? { subagentCredentials: new SubagentCredentials({ credentials: args.subagentCredentials }) } : {}),
    ...(subagentConfig.resultSuffix !== undefined ? { resultSuffix: subagentConfig.resultSuffix } : {}),
    enableExecuteHookExec: args.enableExecuteHookExec ?? false,
    configuredSteps: args.configuredSteps === undefined ? [] : [...args.configuredSteps],
    readonlyShellEnabled: args.readonlyShellEnabled ?? false,
    toolName: args.toolName ?? "Task",
    preparedTimestampUnixMs: BigInt(Date.now()),
  });
}

export function buildPreparedTaskToolHookInput(subagent: InstanceType<typeof PreparedTaskSubagent>): {
  readonly description: string | undefined;
  readonly prompt: string | undefined;
  readonly model: string | undefined;
  readonly resume: string | undefined;
  readonly environment: TaskEnvironment;
  readonly cloud_base_branch: string | undefined;
  readonly cloud_requested_environment_build_id: string | undefined;
  readonly machine: TaskTargetMachine | undefined;
  readonly subagent_type: string;
  readonly run_in_background: boolean | undefined;
  readonly file_attachments: readonly string[] | undefined;
} {
  const storedArgs = subagent.rawArgs;
  if (storedArgs === undefined) {
    return {
      description: undefined,
      prompt: undefined,
      model: undefined,
      resume: undefined,
      environment: undefined,
      cloud_base_branch: undefined,
      cloud_requested_environment_build_id: undefined,
      machine: undefined,
      subagent_type: subagent.subagentTypeName,
      run_in_background: undefined,
      file_attachments: undefined,
    };
  }
  return {
    description: storedArgs.description,
    prompt: storedArgs.prompt,
    model: storedArgs.model,
    resume: storedArgs.resume,
    environment: protoEnvironmentToTaskEnvironment(storedArgs.environment),
    cloud_base_branch: storedArgs.cloudBaseBranch,
    cloud_requested_environment_build_id: storedArgs.cloudRequestedEnvironmentBuildId,
    machine: targetMachineFromProto(storedArgs.machine),
    subagent_type: subagent.subagentTypeName,
    run_in_background: storedArgs.runInBackground,
    file_attachments: storedArgs.attachments.length > 0 ? storedArgs.attachments : undefined,
  };
}

/** Reads the attachments a subagent was given and turns each into what the protocol carries. */
async function collectAttachments(
  ctx: Context,
  attachmentList: readonly string[],
  resourceAccessor: AttachmentResourceAccessor,
  toolCallId: string,
  options?: AttachmentProcessingOptions,
): Promise<SelectedContextValue | undefined> {
  if (attachmentList.length === 0) {
    return undefined;
  }
  const hasVideo = attachmentList.some(
    (attachmentPath) => getPotentialVideoMimeTypeFromPath(attachmentPath) !== undefined,
  );
  const trustedContext =
    options?.skipTrustedPathValidation === true || !hasVideo
      ? undefined
      : await fetchAttachmentTrustContext({ ctx, resourceAccessor });
  const reader = resourceAccessor.get(readExecutorResource);
  const images: InstanceType<typeof SelectedImage>[] = [];
  const videos: InstanceType<typeof SelectedVideo>[] = [];
  for (const rawPath of attachmentList) {
    const attachmentPath =
      trustedContext !== undefined &&
      getPotentialVideoMimeTypeFromPath(rawPath) !== undefined
        ? resolveTrustedAttachmentPath({
            attachmentPath: rawPath,
            requestContext: trustedContext,
          })
        : rawPath;
    if (attachmentPath === undefined) {
      throw untrustedAttachmentPathError(rawPath);
    }
    const readResult = await reader.execute(
      ctx,
      new ReadArgs({ path: attachmentPath, toolCallId }),
      { execId: generateSeededUuid(`${toolCallId}:${attachmentPath}`) },
    );
    if (readResult.result.case !== "success") {
      throw new Error(`Failed to read attachment: ${attachmentPath}`);
    }
    const output = readResult.result.value.output;
    if (output.case !== "data") {
      throw new Error(`Attachment is not binary data: ${attachmentPath}`);
    }
    const bytes = output.value;
    const imageMime = detectImageMimeType(bytes, attachmentPath);
    const foundVideoMime = getPotentialVideoMimeTypeFromPath(attachmentPath);
    const mimeLookup = mimeTypes.lookup(attachmentPath);
    const resolvedMime =
      imageMime ??
      foundVideoMime ??
      (typeof mimeLookup === "string" ? mimeLookup : undefined);
    if (!resolvedMime) {
      throw new Error(`Could not detect mime type for attachment: ${attachmentPath}`);
    }
    const blobId = readResult.result.value.outputBlobId;
    const imagePayload: SelectedImage["dataOrBlobId"] =
      blobId !== undefined && blobId.length > 0
        ? {
            case: "blobIdWithData",
            value: new SelectedImage_BlobIdWithData({
              blobId: new Uint8Array(blobId),
              data: new Uint8Array(bytes),
            }),
          }
        : { case: "data", value: new Uint8Array(bytes) };
    const videoPayload: SelectedVideo["dataOrBlobId"] =
      blobId !== undefined && blobId.length > 0
        ? {
            case: "blobIdWithData",
            value: new SelectedVideo_BlobIdWithData({
              blobId: new Uint8Array(blobId),
              data: new Uint8Array(bytes),
            }),
          }
        : { case: "data", value: new Uint8Array(bytes) };
    if (resolvedMime.startsWith("video/")) {
      const resolvedModelId = options?.resolvedModelId?.trim();
      if (
        resolvedModelId !== undefined &&
        resolvedModelId.length > 0 &&
        !isGeminiModelId(resolvedModelId)
      ) {
        throw new Error("Video attachments are only supported for Gemini models");
      }
      const useSigned =
        options?.privacyMode !== undefined &&
        isSignedUrlStorageAllowed(options.privacyMode) &&
        options.attachedMediaUrlProvider !== undefined;
      const maxBytes = useSigned
        ? options?.useGeminiDeveloperVideoUpload === true &&
          isGeminiVideoSubagentType(options.subagentType)
          ? GEMINI_VIDEO_SUBAGENT_MAX_BYTES
          : options?.signedUrlVideoMaxBytes ?? getSignedUrlVideoMaxBytes({})
        : options?.inlineVideoMaxBytes ?? getInlineVideoMaxBytes({});
      if (bytes.length > maxBytes) {
        throw new Error(
          `Video exceeds maximum size of ${maxBytes} bytes (${Math.round(maxBytes / 1024 / 1024)}MB)`,
        );
      }
      if (useSigned) {
        const conversation = options.conversationId ?? "";
        const signed = await options.attachedMediaUrlProvider.getSignedUrlForAttachedMedia(
          ctx,
          {
            conversationId: conversation,
            mimeType: resolvedMime,
            contentLengthBytes: bytes.length,
          },
        );
        await uploadAttachedMediaToSignedUrl({
          putUrl: signed.putUrl,
          data: new Uint8Array(bytes),
          mimeType: resolvedMime,
          signal: ctx.signal,
        });
        videos.push(
          new SelectedVideo({
            dataOrBlobId: {
              case: "signedUrl",
              value: new SelectedVideo_SignedUrl({
                url: signed.getUrl,
                key: signed.key,
                expiresAtUnixMs: signed.expiresAtUnixMs,
                refreshAfterUnixMs: signed.refreshAfterUnixMs,
                conversationId: conversation,
              }),
            },
            uuid: generateSeededUuid(`video-${attachmentPath}`),
            path: attachmentPath,
            mimeType: resolvedMime,
            fps: 4,
          }),
        );
      } else {
        videos.push(
          new SelectedVideo({
            dataOrBlobId: videoPayload,
            uuid: generateSeededUuid(`video-${attachmentPath}`),
            path: attachmentPath,
            mimeType: resolvedMime,
            fps: 4,
          }),
        );
      }
    } else if (resolvedMime.startsWith("image/")) {
      images.push(
        new SelectedImage({
          dataOrBlobId: imagePayload,
          uuid: generateSeededUuid(`image-${attachmentPath}`),
          path: attachmentPath,
          mimeType: resolvedMime,
        }),
      );
    } else {
      throw new Error(
        `Attachment must be image/* or video/*; got ${resolvedMime} for ${attachmentPath}`,
      );
    }
  }
  if (images.length === 0 && videos.length === 0) {
    return undefined;
  }
  return new SelectedContext({ selectedImages: images, selectedVideos: videos });
}
