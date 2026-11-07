/**
 * The tool that draws an image and puts it in the workspace.
 *
 * Everything interesting about this tool is what it refuses. A model that has been asked for a diagram will
 * happily reach for an image generator at other times too, so the tool is only used when the user asked for
 * an image — and a description too short to be a description, or one carrying a word that suggests the call
 * was not meant to happen at all, is refused with a note saying so rather than sent to a provider that
 * bills for it. A session that may not write refuses it, because the whole point of the tool is to leave a
 * file behind, and a session with no folder to write into says so, since the image would have nowhere to go.
 *
 * The call itself is arranged around three things that can fail independently, and each is recorded as its
 * own stage so a failure can be told apart from the others: reading the reference images the caller named,
 * asking the provider, and writing the result. The provider call is bounded by a concurrency limiter,
 * because image generation is expensive and slow and a model that asks for several at once should not
 * swamp the provider. A provider failure is reported with whatever the provider said — its status, and the
 * error it nested inside its own body — because "the request was rejected" is not actionable without it,
 * and a rejection for content-safety reasons is called that rather than left as a raw error.
 *
 * The result is written into the project's assets folder, or into the run's artifacts folder when there is
 * one, and what the tool renders depends on what the caller can display: an artifacts-folder image is
 * referred to by an image tag so the client shows it, the versions that read a path are given the path, and
 * everything else gets the image bytes themselves, resized if they are larger than a message should carry.
 */

import { Buffer } from "node:buffer"
import { basename, extname, join } from "node:path"
import { z } from "zod"

import {
  createGenerateImageErrorInterop,
  createGenerateImageSuccessInterop,
  createGenerateImageToolCallInterop,
  emptyGenerateImageToolCallInterop,
  generateImageResultTextInterop,
  mergeGenerateImageToolCallInterop,
  projectGenerateImageResultInterop,
  serializeGenerateImageErrorInterop,
  wrapGenerateImageToolCallInterop,
  type GenerateImageEnvelopeInterop,
  type GenerateImageResultInterop,
  type GenerateImageToolCallInterop,
} from "../../../../adapters/interop/agent/generate-image-protocol-adapter.ts"
import type { Context } from "../../../context/context.ts"
import { summarizeAbortReason } from "../../../context/abort.ts"
import { createSpan } from "../../../context/telemetry.ts"
import { createLogger } from "../../../context/index.ts"
import { createCounter, createHistogram } from "../../../metrics/index.ts"
import { PrivacyMode, type PrivacyMode as PrivacyModeValue } from "../../../redaction/privacy-mode.ts"
import { DataClassification } from "../../../redaction/classification.ts"
import { formatRedacted, shouldRedact } from "../../../redaction/should-redact.ts"
import { resizeImageBufferIfNeeded } from "../../../utils/image-resize.ts"
import { createImageResult, createStringResult } from "../../../chat-inference/prompt-executor.ts"
import { readExecutorResource, type ReadExecutor } from "../../../agent-exec/read-operation.ts"
import { writeExecutorResource, type WriteExecutor, type WriteExecutorResult } from "../../../agent-exec/write-operation.ts"
import type { ResourceAccessor } from "../../../agent-exec/resource-provider.ts"
import type { RemoteExecManager } from "../../../agent-exec/executor-resources.ts"
import { ASK_MODE_MODEL_ERROR, createZodAgentTool, withSafeParsedArgs } from "../tool-support.ts"
import {
  CustomToolCallError,
  ToolCallAbortedError,
  ToolCallError,
  ToolCallRejectedError,
  ToolCallUnexpectedEnvironmentError,
  ToolErrorClassification,
} from "../tool-errors.ts"

const logger = createLogger("agent/tools/generate-image");
const DEFAULT_IMAGE_CONCURRENCY = 2;
const SHORT_DESCRIPTION_WORDS = 5;
const TINY_DESCRIPTION_WORDS = 3;
const MODEL_RESTRICTED_ERROR = "GenerateImage is not available for the current selected model. If important to generate an image (e.g. the user asked for it), then ask the user to switch models.";
const NO_PROJECT_FOLDER_ERROR = "generate_image needs a workspace/project folder so it has somewhere to save the PNG. Open a folder or run from a workspace, then try again.";
const CONTENT_SAFETY_BLOCKED_ERROR = "The image generation was blocked due to content safety policies.";
const DEFAULT_SUSPICIOUS_KEYWORDS = ["ignore", "skip", "stop", "noop"] as const;
const SUPPORTED_ASPECT_RATIOS = ["1:1", "4:3", "3:4", "16:9", "9:16"] as const;

const writeResultCounter = createCounter("agent.tools.generate_image.write_result", {
  description: "Generate image write results by case and targetLocation",
  labelNames: ["result", "targetLocation", "operation", "is_readonly"],
});
const abortCounter = createCounter("agent.tools.generate_image.abort", {
  description: "Generate image aborts by phase and normalized reason",
  labelNames: ["phase", "abort_reason_type"],
});
const executeFinishCounter = createCounter("agent.tools.generate_image.execute.finished", {
  description: "Generate image tool execute outcomes",
  labelNames: ["outcome"],
});
const executeErrorCounter = createCounter("agent.tools.generate_image.execute.error", {
  description: "Generate image tool execute failures by stage",
  labelNames: ["stage"],
});
const executeDuration = createHistogram("agent.tools.generate_image.execute.duration_ms", {
  description: "End-to-end generate image execute latency in milliseconds",
  labelNames: ["outcome"],
});
const renderFinishCounter = createCounter("agent.tools.generate_image.render.finished", {
  description: "Generate image tool render outcomes",
  labelNames: ["outcome"],
});
const shortDescriptionCounter = createCounter("agent.tools.generate_image.short_prompt", {
  description: "Generate image invocations where the description was rejected as too short or suspicious",
  labelNames: ["word_count"],
});

function recordStageError(context: Context, stage: FailureStage): void {
  executeErrorCounter.increment(context, 1, { stage });
}

function recordExecuteFinish(context: Context, outcome: string): void {
  executeFinishCounter.increment(context, 1, { outcome });
}

function recordRenderFinish(context: Context, outcome: string): void {
  renderFinishCounter.increment(context, 1, { outcome });
}

function isResizeFailure(error: unknown): boolean {
  if (!(error instanceof Error)) return false;
  const message = error.message.toLowerCase();
  return message.includes("resize") || message.includes("sharp");
}

type FailureStage = "project_folder" | "provider_inference" | "write_output" | "read_reference_images";

function finishForStage(stage: FailureStage): string {
  switch (stage) {
    case "project_folder": return "missing_project_folder";
    case "provider_inference": return "provider_error";
    case "write_output": return "write_error";
    case "read_reference_images": return "internal_error";
  }
}

function abortKindOf(reasonInfo: ReturnType<typeof summarizeAbortReason>): string {
  // Only an abort reason that was an error carries a name; the rest carry a message or nothing.
  const errorName = "abortReasonName" in reasonInfo ? reasonInfo.abortReasonName : "";
  const reasonMessage = "abortReasonMessage" in reasonInfo ? reasonInfo.abortReasonMessage : "";
  const details = `${errorName} ${reasonMessage}`.toLowerCase();
  if (errorName === "ToolCallAbortedError" || /user|cancel|cancelled|canceled/.test(details)) return "user_abort";
  if (/disconnect|connection|socket|client closed|broken pipe|econnreset/.test(details)) return "client_disconnect";
  if (/timeout|timed out|deadline|etimedout/.test(details)) return "request_timeout";
  return "internal_error";
}

function abortFinishOf(reason: unknown): { reasonInfo: ReturnType<typeof summarizeAbortReason>; finishOutcome: string } {
  const reasonInfo = summarizeAbortReason(reason);
  return { reasonInfo, finishOutcome: abortKindOf(reasonInfo) };
}

export interface GenerateImageRequestContext {
  readonly env?: {
    readonly projectFolder?: string;
    readonly artifactsFolder?: string;
    readonly workspacePaths?: readonly string[];
  };
}

export interface GenerateImageStateHandler {
  usesLargeContextTreatment?(): boolean;
  getPrivacyMode?(): PrivacyModeValue;
  addTurnUsage?(usage: unknown): void;
}

export interface GeneratedImageToolResult {
  readonly filePath: string;
  readonly imageData: string;
  readonly usage?: unknown;
}

export interface GenerateImageService {
  (
    context: Context,
    description: string,
    filename?: string,
    referenceImages?: readonly unknown[],
    aspectRatio?: string,
  ): Promise<GeneratedImageToolResult>;
}

export interface GenerateImageToolDependencies {
  readonly resourceAccessor: ResourceAccessor<RemoteExecManager>;
  readonly generateImageService: GenerateImageService;
  readonly promptVersion?: string;
  readonly requestContext?: GenerateImageRequestContext;
  readonly imageGenerationConcurrencyLimiter?: ImageGenerationConcurrencyLimiter;
  readonly isReadonly?: boolean;
  readonly suspiciousKeywords?: readonly string[];
  readonly isModelRestricted?: boolean;
}

export interface ImageGenerationConcurrencyLimiter {
  acquire(): Promise<void>;
  release(): void;
}

export function createImageGenerationConcurrencyLimiter(
  maxConcurrent = DEFAULT_IMAGE_CONCURRENCY,
): ImageGenerationConcurrencyLimiter {
  const maxInFlight = Math.trunc(Number(maxConcurrent));
  if (!Number.isFinite(maxInFlight) || maxInFlight < 1) {
    throw new RangeError(`createImageGenerationConcurrencyLimiter: maxConcurrent must be a finite number >= 1, got ${maxConcurrent}`);
  }
  let inFlight = 0;
  const queue: Array<() => void> = [];
  return {
    async acquire() {
      if (inFlight < maxInFlight) {
        inFlight += 1;
        return;
      }
      await new Promise<void>(resolve => queue.push(resolve));
    },
    release() {
      const waiter = queue.shift();
      if (waiter !== undefined) waiter();
      else if (inFlight > 0) inFlight -= 1;
    },
  };
}

function generateImageCall(toolCall: GenerateImageToolCallInterop): GenerateImageEnvelopeInterop {
  return wrapGenerateImageToolCallInterop(toolCall);
}

function toolNameForVersion(promptVersion: string): string {
  switch (promptVersion) {
    case "dsv3-1018": return "generate_image";
    case "cursor-0226":
    case "dsv3-1205":
    case "latest":
    case "gpt5-codex":
    case "codex-cloud":
    case "haiku": return "GenerateImage";
    default: throw new Error(`Unhandled version: ${promptVersion}`);
  }
}

function descriptionForVersion(promptVersion: string): string {
  switch (promptVersion) {
    case "cursor-0226":
    case "dsv3-1205":
    case "gpt5-codex":
    case "codex-cloud":
    case "dsv3-1018":
    case "latest":
    case "haiku":
      return `Generate an image file from a text description.

STRICT INVOCATION RULES (must follow):
- Only use this tool when the user explicitly asks for an image. Do not generate images "just to be helpful".
- Do not use this tool for data heavy visualizations such as charts, plots, tables.

General guidelines:
- Provide a concrete description first: subject(s), layout, style, colors, text (if any), and constraints.
- If the user requests an aspect ratio, set \`aspect_ratio\` to one of "1:1", "4:3", "3:4", "16:9", or "9:16".
- If the user provides reference images, include them in \`reference_image_paths\`.
- Do not repeat generated images as Markdown in your response; the client displays tool-generated images automatically.
`;
    default: throw new Error(`Unhandled version: ${promptVersion}`);
  }
}

function mimeTypeOfPath(imagePath: string): string {
  switch (extname(imagePath).toLowerCase()) {
    case ".jpg":
    case ".jpeg": return "image/jpeg";
    case ".gif": return "image/gif";
    case ".webp": return "image/webp";
    default: return "image/png";
  }
}

function redactPathIfNeeded(path: string, privacyMode: PrivacyModeValue, fieldName: string): string {
  return shouldRedact(privacyMode, DataClassification.PATH) ? formatRedacted(fieldName) : path;
}

function logPath(path: string, privacyMode: PrivacyModeValue, fieldName: string): string {
  return redactPathIfNeeded(path, privacyMode, fieldName);
}

interface ProviderFailureFields {
  code?: string;
  message?: string;
}

function providerFieldsOf(responseData: unknown): ProviderFailureFields {
  const topErrorSchema = z.object({
    error: z.object({
      message: z.string().optional(),
      provider: z.object({ body: z.string().optional() }).optional(),
    }).optional(),
  });
  const nestedProviderErrorSchema = z.object({
    error: z.object({ code: z.string().optional(), message: z.string().optional() }).optional(),
  });
  const topParsed = topErrorSchema.safeParse(responseData);
  if (!topParsed.success || topParsed.data.error === undefined) return {};
  const topError = topParsed.data.error;
  let nestedCode: string | undefined;
  let nestedMessage: string | undefined;
  const providerBody = topError.provider?.body;
  if (providerBody !== undefined) {
    let nestedJson: unknown;
    try { nestedJson = JSON.parse(providerBody); } catch { nestedJson = undefined; }
    const nestedParsed = nestedProviderErrorSchema.safeParse(nestedJson);
    if (nestedParsed.success) {
      nestedCode = nestedParsed.data.error?.code?.trim();
      nestedMessage = nestedParsed.data.error?.message?.trim();
    }
  }
  const fields: ProviderFailureFields = {};
  const code = nestedCode !== undefined && nestedCode.length > 0 ? nestedCode : undefined;
  const message = nestedMessage !== undefined && nestedMessage.length > 0
    ? nestedMessage
    : topError.message !== undefined && topError.message.trim().length > 0 ? topError.message.trim() : undefined;
  if (code !== undefined) fields.code = code;
  if (message !== undefined) fields.message = message;
  return fields;
}

function providerSummaryOf(responseData: unknown): string | undefined {
  const { message: providerMessage, code: providerCode } = providerFieldsOf(responseData);
  if (providerMessage === undefined && providerCode === undefined) return undefined;
  const metadata = providerCode === undefined ? "" : ` (code=${providerCode})`;
  return `${providerMessage ?? "Image generation request rejected by provider"}${metadata}`;
}

function recordOf(value: unknown): Record<string, unknown> | undefined {
  return typeof value === "object" && value !== null ? value as Record<string, unknown> : undefined;
}

function isSafetyBlocked(error: unknown): boolean {
  if (error instanceof Error && error.name === "ImageGenerationContentSafetyError") return true;
  const record = recordOf(error);
  if (record === undefined) return false;
  const response = recordOf(record.response);
  const fields = providerFieldsOf(response?.data);
  if (fields.code === "moderation_blocked") return true;
  return record.cause === undefined ? false : isSafetyBlocked(record.cause);
}

function providerStatusOf(error: unknown): number | undefined {
  const record = recordOf(error);
  if (record === undefined) return undefined;
  const response = recordOf(record.response);
  if (typeof response?.status === "number") return response.status;
  return record.cause === undefined ? undefined : providerStatusOf(record.cause);
}

function providerDetailsOf(error: unknown): string | undefined {
  const record = recordOf(error);
  if (record === undefined) return undefined;
  const response = recordOf(record.response);
  const status = typeof response?.status === "number" ? response.status : undefined;
  const statusText = typeof response?.statusText === "string" ? response.statusText : undefined;
  const providerErrorSummary = providerSummaryOf(response?.data);
  if (status !== undefined || providerErrorSummary !== undefined) {
    const pieces: string[] = [];
    if (status !== undefined) pieces.push(statusText !== undefined && statusText.trim().length > 0 ? `status=${status} ${statusText}` : `status=${status}`);
    if (providerErrorSummary !== undefined) pieces.push(`provider_error=${providerErrorSummary}`);
    return pieces.join(", ");
  }
  return record.cause === undefined ? undefined : providerDetailsOf(record.cause);
}

function baseMessageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function detailedMessageOf(error: unknown): string {
  const baseMessage = baseMessageOf(error);
  const providerDetails = providerDetailsOf(error);
  if (providerDetails === undefined || baseMessage.includes(providerDetails)) return baseMessage;
  return `${baseMessage}. ${providerDetails}`;
}

interface ReferenceImage {
  readonly data: string;
  readonly mimeType: string;
}

async function readReferenceImages(
  context: Context,
  readExecutor: ReadExecutor,
  paths: readonly string[],
  toolCallId: string,
  privacyMode: PrivacyModeValue,
): Promise<readonly ReferenceImage[]> {
  if (paths.length === 0) return [];
  const results = await Promise.all(paths.map(async path => {
    const logImagePath = logPath(path, privacyMode, "image_path");
    try {
      const result = await readExecutor.execute(context, { path, toolCallId });
      if (result.kind !== "success") {
        logger.warn(context, "[generate-image] ref image read failed", { imagePath: logImagePath });
        return null;
      }
      const output = result.output;
      if (output?.kind !== "data" || output.bytes.length === 0) {
        logger.warn(context, "[generate-image] ref image read empty", { imagePath: logImagePath });
        return null;
      }
      logger.info(context, "[generate-image] ref image read success", { imagePath: logImagePath, dataLength: output.bytes.length });
      return {
        data: Buffer.from(output.bytes).toString("base64"),
        mimeType: mimeTypeOfPath(path),
      };
    } catch (error) {
      logger.error(context, "[generate-image] ref image read failed", { imagePath: logImagePath, error: error instanceof Error ? error.message : String(error) });
      return null;
    }
  }));
  return results.filter((result): result is ReferenceImage => result !== null && result !== undefined);
}

function stripDataUri(imageData: string): string {
  return imageData.includes(",") ? imageData.split(",")[1] ?? "" : imageData;
}

function portableBaseName(filePath: string): string {
  return basename(filePath.replaceAll("\\", "/"));
}

function imageOutputPathOf(options: { folder: string; filename: string; artifactsFolder?: string }): string {
  const { folder, filename, artifactsFolder } = options;
  return join(artifactsFolder || folder, "assets", filename);
}

type ImageWriteResultView =
  | { readonly kind: "success" }
  | { readonly kind: "error"; readonly error: string }
  | { readonly kind: "permission-denied"; readonly operation: string; readonly isReadonly: boolean; readonly error: string }
  | { readonly kind: "rejected"; readonly reason: string }
  | { readonly kind: "no-space" }
  | { readonly kind: "unknown" }

function imageWriteResultView(result: WriteExecutorResult): ImageWriteResultView {
  switch (result.kind) {
    case "success": return { kind: "success" };
    case "error": return { kind: "error", error: result.error };
    case "permission-denied": return {
      kind: "permission-denied",
      operation: result.operation || "unknown",
      isReadonly: result.isReadonly,
      error: result.message,
    };
    case "rejected": return { kind: "rejected", reason: result.reason };
    case "no-space": return { kind: "no-space" };
    case "unrecognized": return { kind: "unknown" };
  }
}

function writeResultMetricKind(result: WriteExecutorResult): string {
  switch (result.kind) {
    case "permission-denied": return "permissionDenied";
    case "no-space": return "noSpace";
    case "unrecognized": return "undefined";
    default: return result.kind;
  }
}

async function writeGeneratedImage(
  context: Context,
  writeExecutor: WriteExecutor,
  options: {
    readonly folder: string;
    readonly filePath: string;
    readonly imageData: string;
    readonly artifactsFolder?: string;
    readonly privacyMode?: PrivacyModeValue;
  },
): Promise<GenerateImageResultInterop> {
  const { folder, filePath, imageData, artifactsFolder } = options;
  const targetLocation = artifactsFolder ? "artifacts" : "project";
  const path = imageOutputPathOf({ folder, filename: portableBaseName(filePath), ...(artifactsFolder === undefined ? {} : { artifactsFolder }) });
  const binaryBytes = Buffer.from(stripDataUri(imageData), "base64");
  const privacyMode = options.privacyMode ?? PrivacyMode.UNSPECIFIED;
  const result = await writeExecutor.execute(context, {
    path,
    bytes: new Uint8Array(binaryBytes),
    includeContentAfterWrite: false,
  });
  const writeView = imageWriteResultView(result);
  const caseName = writeResultMetricKind(result);
  const permissionState = writeView.kind === "permission-denied"
    ? { operation: writeView.operation, isReadonly: writeView.isReadonly ? "true" : "false" }
    : { operation: "n/a", isReadonly: "n/a" };
  writeResultCounter.increment(context, 1, {
    result: caseName,
    targetLocation,
    operation: permissionState.operation,
    is_readonly: permissionState.isReadonly,
  });
  if (writeView.kind === "success") {
    logger.info(context, "[generate-image] write success", { outputPath: logPath(path, privacyMode, "output_path"), size: binaryBytes.length });
    return createGenerateImageSuccessInterop({ filePath: path, imageData: artifactsFolder ? "" : imageData });
  }
  if (writeView.kind === "permission-denied" && writeView.isReadonly) {
    return createGenerateImageErrorInterop(ASK_MODE_MODEL_ERROR);
  }
  let failureText: string;
  let failure: Error;
  switch (writeView.kind) {
    case "error":
      failureText = writeView.error;
      failure = new Error(`Failed to save generated image: ${failureText}`);
      break;
    case "permission-denied":
      failureText = `permission denied (operation=${writeView.operation}, isReadonly=${writeView.isReadonly}, error=${writeView.error})`;
      failure = new ToolCallUnexpectedEnvironmentError(`Failed to save generated image: ${failureText}`);
      break;
    case "rejected": {
      failureText = `rejected (reason=${writeView.reason})`;
      const message = `Failed to save generated image: ${failureText}`;
      failure = writeView.reason.includes("Failed to find tool call context") ? new Error(message) : new ToolCallRejectedError(message);
      break;
    }
    case "no-space":
      failureText = "No space left on device";
      failure = new CustomToolCallError(ToolErrorClassification.BAD_USER_DEVICE_STATE, { clientVisibleErrorMessage: `Failed to save generated image: ${failureText}`, modelVisibleErrorMessage: `Failed to save generated image: ${failureText}`, error: `Failed to save generated image: ${failureText}` });
      break;
    case "unknown":
      failureText = "unknown result case";
      failure = new Error(`Failed to save generated image: ${failureText}`);
      break;
  }
  logger.error(context, "[generate-image] write failed", { outputPath: logPath(path, privacyMode, "output_path"), caseName, error: failureText });
  throw failure;
}

function resultTextOf(result: GenerateImageResultInterop): string {
  return generateImageResultTextInterop(result)
}

function isGenerateImageOptions(value: unknown): value is GenerateImageToolDependencies {
  return typeof value === "object" && value !== null && "resourceAccessor" in value && "generateImageService" in value;
}

export function createGenerateImageTool(
  resourceAccessor: ResourceAccessor<RemoteExecManager>,
  generateImageService: GenerateImageService,
  promptVersion?: string,
  requestContext?: GenerateImageRequestContext,
  imageGenerationConcurrencyLimiter?: ImageGenerationConcurrencyLimiter,
  isReadonly?: boolean,
  suspiciousKeywords?: readonly string[],
  isModelRestricted?: boolean,
): ReturnType<typeof createZodAgentTool>;
export function createGenerateImageTool(dependencies: GenerateImageToolDependencies): ReturnType<typeof createZodAgentTool>;
export function createGenerateImageTool(
  resourceAccessorOrDependencies: ResourceAccessor<RemoteExecManager> | GenerateImageToolDependencies,
  generateImageService?: GenerateImageService,
  promptVersion?: string,
  requestContext?: GenerateImageRequestContext,
  imageGenerationConcurrencyLimiter?: ImageGenerationConcurrencyLimiter,
  isReadonly?: boolean,
  suspiciousKeywords: readonly string[] = DEFAULT_SUSPICIOUS_KEYWORDS,
  isModelRestricted?: boolean,
): ReturnType<typeof createZodAgentTool> {
  let legacyObjectForm = false;
  if (isGenerateImageOptions(resourceAccessorOrDependencies) && generateImageService === undefined) {
    legacyObjectForm = true;
    const dependencies = resourceAccessorOrDependencies;
    generateImageService = dependencies.generateImageService;
    promptVersion = dependencies.promptVersion;
    requestContext = dependencies.requestContext;
    imageGenerationConcurrencyLimiter = dependencies.imageGenerationConcurrencyLimiter;
    isReadonly = dependencies.isReadonly;
    suspiciousKeywords = dependencies.suspiciousKeywords ?? DEFAULT_SUSPICIOUS_KEYWORDS;
    isModelRestricted = dependencies.isModelRestricted;
    resourceAccessorOrDependencies = dependencies.resourceAccessor;
  }
  if (typeof generateImageService !== "function") throw new TypeError("createGenerateImageTool: generateImageService is required");
  const resourceAccessor = resourceAccessorOrDependencies as ResourceAccessor<RemoteExecManager>;
  const generateImage = generateImageService;
  const version = promptVersion ?? "latest";
  const blockedKeywords = suspiciousKeywords;
  const parameters = z.object({
    description: z.string().describe("A detailed description of the image."),
    filename: z.string().optional().describe("Optional filename for the generated image (e.g., 'diagram.png'). Do not include a directory path - the tool automatically handles where to save and how to display the image. If not provided, a timestamped filename will be generated."),
    reference_image_paths: z.array(z.string()).optional().describe("Optional array of file paths to reference images as additional inputs."),
    aspect_ratio: z.enum(SUPPORTED_ASPECT_RATIOS).optional().describe('Optional aspect ratio for the generated image. Supported values are "1:1", "4:3", "3:4", "16:9", and "9:16".'),
  });
  const execute = async (
    parentCtx: Context,
    interactionHandler: { executeToolCall: (context: Context, toolCall: ReturnType<typeof generateImageCall>, toolCallId: string, run: (context: Context) => Promise<GenerateImageResultInterop>, merge: (result: GenerateImageResultInterop) => ReturnType<typeof generateImageCall>) => Promise<GenerateImageResultInterop> },
    inputArgs: z.infer<typeof parameters>,
    callMeta: { readonly toolCallId: string; readonly stateHandler?: GenerateImageStateHandler },
  ): Promise<GenerateImageResultInterop> => {
    using executionSpan = createSpan(parentCtx.withName("generateImageExecute"));
    const startedAtMs = Date.now();
    let finishLogged = false;
    let failureStage: FailureStage | undefined;
    let outcome = "internal_error";
    const trimmedText = inputArgs.description.trim();
    const descriptionWords = trimmedText.length > 0 ? trimmedText.split(/\s+/) : [];
    const wordCount = descriptionWords.length;
    const lowerText = inputArgs.description.toLowerCase();
    const looksUnintended = wordCount <= TINY_DESCRIPTION_WORDS || wordCount <= SHORT_DESCRIPTION_WORDS && blockedKeywords.some(keyword => lowerText.includes(keyword));
    if (isModelRestricted) {
      outcome = "model_restricted";
      recordExecuteFinish(parentCtx, outcome);
      finishLogged = true;
      executeDuration.histogram(parentCtx, Date.now() - startedAtMs, { outcome: outcome });
      return createGenerateImageErrorInterop(MODEL_RESTRICTED_ERROR);
    }
    if (looksUnintended) {
      shortDescriptionCounter.increment(parentCtx, 1, { word_count: String(wordCount) });
      logger.warn(parentCtx, "[generate-image] short/suspicious prompt rejected", { wordCount: wordCount });
      outcome = "short_prompt_rejected";
      recordExecuteFinish(parentCtx, outcome);
      finishLogged = true;
      executeDuration.histogram(parentCtx, Date.now() - startedAtMs, { outcome: outcome });
      return createGenerateImageErrorInterop("Image generation was not performed — the tool call appears to be unintended. Do not retry or call GenerateImage again unless the user explicitly asks for an image.");
    }
    if (isReadonly) {
      outcome = "readonly_rejected";
      recordExecuteFinish(parentCtx, outcome);
      finishLogged = true;
      executeDuration.histogram(parentCtx, Date.now() - startedAtMs, { outcome: outcome });
      return createGenerateImageErrorInterop(ASK_MODE_MODEL_ERROR);
    }
    const baseCall = createGenerateImageToolCallInterop({
      description: inputArgs.description,
      ...(inputArgs.reference_image_paths === undefined ? {} : { referenceImagePaths: inputArgs.reference_image_paths }),
      ...(inputArgs.filename === undefined ? {} : { filename: inputArgs.filename }),
      ...(inputArgs.aspect_ratio === undefined ? {} : { aspectRatio: inputArgs.aspect_ratio }),
    });
    try {
      const result = await interactionHandler.executeToolCall(executionSpan.ctx, generateImageCall(baseCall), callMeta.toolCallId, async context => {
        const env = requestContext?.env;
        const folder = env?.projectFolder || env?.artifactsFolder || env?.workspacePaths?.[0];
        if (folder === undefined || folder.trim().length === 0) {
          failureStage = "project_folder";
          recordStageError(context, "project_folder");
          logger.error(context, "[generate-image] no project folder available to save the generated image", { generate_image: { projectFolder: env?.projectFolder, artifactsFolder: env?.artifactsFolder, workspacePaths: env?.workspacePaths } });
          throw new ToolCallUnexpectedEnvironmentError(NO_PROJECT_FOLDER_ERROR);
        }
        const readExecutor = resourceAccessor.get(readExecutorResource);
        const writeExecutor = resourceAccessor.get(writeExecutorResource);
        const privacyMode = callMeta.stateHandler?.getPrivacyMode?.() ?? PrivacyMode.UNSPECIFIED;
        let readImages: readonly ReferenceImage[];
        try {
          readImages = await readReferenceImages(context, readExecutor, inputArgs.reference_image_paths ?? [], callMeta.toolCallId, privacyMode);
        } catch (error) {
          failureStage = "read_reference_images";
          recordStageError(context, "read_reference_images");
          throw error;
        }
        await imageGenerationConcurrencyLimiter?.acquire();
        try {
          let generatedImage: GeneratedImageToolResult;
          try {
            generatedImage = await generateImage(executionSpan.ctx, inputArgs.description, inputArgs.filename, readImages.length > 0 || legacyObjectForm ? readImages : undefined, inputArgs.aspect_ratio);
            if (generatedImage.usage !== undefined) callMeta.stateHandler?.addTurnUsage?.(generatedImage.usage);
          } catch (error) {
            failureStage = "provider_inference";
            recordStageError(context, "provider_inference");
            throw error;
          }
          try {
            return await writeGeneratedImage(context, writeExecutor, { folder, filePath: generatedImage.filePath, imageData: generatedImage.imageData, ...(env?.artifactsFolder === undefined ? {} : { artifactsFolder: env.artifactsFolder }), privacyMode });
          } catch (error) {
            failureStage = "write_output";
            recordStageError(context, "write_output");
            throw error;
          }
        } finally {
          imageGenerationConcurrencyLimiter?.release();
        }
      }, result => generateImageCall(mergeGenerateImageToolCallInterop(baseCall, result)));
      outcome = "success";
      recordExecuteFinish(parentCtx, outcome);
      finishLogged = true;
      return result;
    } catch (error) {
      const isAborted = parentCtx.signal.aborted || error instanceof ToolCallAbortedError || error instanceof Error && error.name === "AbortError";
      if (isAborted) {
        const { reasonInfo, finishOutcome } = abortFinishOf(parentCtx.reason);
        if (!finishLogged) {
          outcome = finishOutcome;
          recordExecuteFinish(parentCtx, outcome);
          finishLogged = true;
        }
        abortCounter.increment(parentCtx, 1, { phase: "execute", abort_reason_type: finishOutcome });
        logger.warn(parentCtx, "[generate-image] aborted", { ...reasonInfo, abortReason: finishOutcome });
      } else if (!finishLogged) {
        const finishOutcome = failureStage === undefined ? "internal_error" : finishForStage(failureStage);
        outcome = finishOutcome;
        recordExecuteFinish(parentCtx, outcome);
        finishLogged = true;
      }
      if (!isAborted && isSafetyBlocked(error)) throw new CustomToolCallError(ToolErrorClassification.INVALID_ARGS, { clientVisibleErrorMessage: CONTENT_SAFETY_BLOCKED_ERROR, modelVisibleErrorMessage: CONTENT_SAFETY_BLOCKED_ERROR, error: CONTENT_SAFETY_BLOCKED_ERROR });
      const providerDetails = providerDetailsOf(error);
      if (!isAborted && providerDetails !== undefined) {
        const baseMessage = baseMessageOf(error);
        const classification = providerStatusOf(error) === 400 ? ToolErrorClassification.INVALID_ARGS : ToolErrorClassification.PROVIDER_ERROR;
        throw new CustomToolCallError(classification, { clientVisibleErrorMessage: baseMessage, modelVisibleErrorMessage: baseMessage, error: detailedMessageOf(error) });
      }
      throw error;
    } finally {
      if (!finishLogged) recordExecuteFinish(parentCtx, outcome);
      executeDuration.histogram(parentCtx, Date.now() - startedAtMs, { outcome: outcome });
    }
  };
  return createZodAgentTool("GENERATE_IMAGE", {
    name: toolNameForVersion(version),
    contextType: { type: "dynamic" },
    descriptionGenerator: () => descriptionForVersion(version),
    parameters,
    execute: withSafeParsedArgs(parameters, execute as never, generateImageCall(emptyGenerateImageToolCallInterop())),
    render: async (context: Context, result: GenerateImageResultInterop) => {
      let renderOutcome = "internal_error";
      try {
        const resultView = projectGenerateImageResultInterop(result);
        if (resultView.kind === "success") {
          const { filePath, imageData } = resultView;
          const artifactsFolder = requestContext?.env?.artifactsFolder;
          if (artifactsFolder && filePath.startsWith(artifactsFolder)) {
            renderOutcome = "success";
            return createStringResult(`Successfully generated image. Display it in your response using:\n<img src="${filePath}" alt="Generated image" />`);
          }
          if (version === "dsv3-1018" || version === "dsv3-1205" || version === "cursor-0226") {
            renderOutcome = "success";
            return createStringResult(resultTextOf(result));
          }
          if (!imageData) {
            renderOutcome = "missing_image_data";
            return createStringResult("Failed to generate image: no image data returned");
          }
          try {
            const resized = await resizeImageBufferIfNeeded(Buffer.from(stripDataUri(imageData), "base64"));
            renderOutcome = "success";
            return createImageResult(Buffer.from(resized.data).toString("base64"), resized.mimeType, resultTextOf(result));
          } catch (error) {
            renderOutcome = isResizeFailure(error) ? "resize_error" : "internal_error";
            throw error;
          }
        }
        if (resultView.kind === "error" && resultView.error === ASK_MODE_MODEL_ERROR) {
          renderOutcome = "success";
          return createStringResult(ASK_MODE_MODEL_ERROR);
        }
        renderOutcome = "success";
        return createStringResult(resultTextOf(result));
      } finally {
        recordRenderFinish(context, renderOutcome);
      }
    },
      serializeError: (error: unknown) => serializeGenerateImageErrorInterop(error instanceof ToolCallError ? error.clientVisibleErrorMessage : baseMessageOf(error)),
  });
}
