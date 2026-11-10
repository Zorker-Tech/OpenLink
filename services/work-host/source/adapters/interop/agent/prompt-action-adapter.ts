import {
  UserMessage,
} from "../proto/generated/agent/v1/agent_pb.ts";
import {
  SelectedContext,
  SelectedImage,
  SelectedVideo,
} from "../proto/generated/agent/v1/selected_context_pb.ts";
import type { SlateImageAttachment } from "../../../packages/agent/context/image-attachment-contracts.ts"
import type { SlateVideoAttachment } from "../../../packages/agent/context/video-attachment-contracts.ts"
import { toInteropSelectedImage } from "./selected-context-entry-adapter.ts"
import { fromInteropSelectedVideo, toInteropSelectedVideo } from "./video-attachment-adapter.ts"
import { fromInteropSelectedContextState } from "./selected-context-state-adapter.ts"
import { fromInteropUserMessage } from "./user-message-action-protocol-adapter.ts"
import { SlateAgentActionKind, type SlateUserMessageAction } from "../../../packages/agent/agent-action-state.ts"
import {
  createSlateUserMessageInput,
  type SlateUserMessage,
  type SlateUserMessageInput,
} from "../../../packages/agent/user-message-state.ts"
import { PrivacyMode } from "../../../packages/redaction/privacy-mode.ts"
import { isRedactedString } from "../../../packages/redaction/redacted-values.ts"

export interface InteropTurnPromptOptions {
  readonly attachedFilePaths?: readonly string[];
  readonly attachedFileSizes?: ReadonlyMap<string, number>;
  readonly richText?: string;
  readonly replyContext?: unknown;
  readonly messageId?: string;
  readonly automationWake?: { readonly id?: string; readonly containsUntrustedEventText?: boolean };
  readonly isSilenceAllowed?: boolean;
  readonly appendReplyReminder?: boolean;
  readonly hidden?: boolean;
  readonly skippedQuestionPrompts?: readonly string[];
  readonly dismissedQuestionPrompts?: readonly string[];
  readonly selectedImages?: readonly (SelectedImage | SlateImageAttachment | { readonly data: Uint8Array; readonly path?: string; readonly mimeType?: string })[];
  readonly selectedVideos?: readonly SelectedVideo[];
  readonly recentUserMessages?: readonly { readonly id: string; readonly text: string; readonly richText?: string }[];
}

export interface SlateTurnActionAssembly {
  readonly action: SlateUserMessageAction;
  readonly automationStatusReminder: string | null;
  readonly automationStatusCompactionEpoch: number;
}

export interface RunnerTurnPromptOptionsInput {
  readonly selectedImages?: readonly unknown[];
  readonly selectedVideos?: readonly unknown[];
  readonly attachedFilePaths?: readonly string[];
  readonly attachedFileSizes?: ReadonlyMap<string, number>;
  readonly richText?: string;
  readonly replyContext?: unknown;
  readonly messageId?: string;
  readonly automationWake?: { readonly id: string };
  readonly isSilenceAllowed?: boolean;
  readonly appendReplyReminder?: boolean;
  readonly hidden?: boolean;
  readonly recentUserMessages?: readonly { readonly id: string; readonly text: string }[];
}

export type SlateTurnVideoInput = SelectedVideo | SlateVideoAttachment | {
  readonly path: string
  readonly filename?: string
  readonly data?: Uint8Array
  readonly blobId?: string
}

/** Narrows the selected-video message only at the prompt interop boundary. */
export function isInteropSelectedVideo(value: unknown): value is SelectedVideo {
  if (typeof value !== "object" || value === null) return false;
  const fields = value as Record<string, unknown>;
  const dataOrBlobId = fields.dataOrBlobId;
  return typeof fields.uuid === "string"
    && typeof fields.path === "string"
    && typeof fields.mimeType === "string"
    && typeof fields.filename === "string"
    && typeof fields.materializeToFilesystem === "boolean"
    && typeof dataOrBlobId === "object"
    && dataOrBlobId !== null
    && typeof (dataOrBlobId as Record<string, unknown>).case === "string";
}

function isSlateImage(value: unknown): value is SlateImageAttachment {
  if (typeof value !== "object" || value === null) return false
  const fields = value as Record<string, unknown>
  return typeof fields.id === "string" && typeof fields.sourcePath === "string" && typeof fields.mediaType === "string"
}

function isSlateVideo(value: unknown): value is SlateVideoAttachment {
  if (typeof value !== "object" || value === null) return false
  const fields = value as Record<string, unknown>
  return typeof fields.sourcePath === "string" && typeof fields.displayName === "string" &&
    typeof fields.mediaType === "string" && typeof fields.writeToWorkspace === "boolean"
}

function selectedImageFromRunner(value: unknown): SelectedImage | undefined {
  if (isSlateImage(value)) return toInteropSelectedImage(value)
  if (value instanceof SelectedImage) return value
  if (typeof value !== "object" || value === null) return undefined
  const fields = value as Record<string, unknown>
  if (fields.dataOrBlobId !== undefined && typeof fields.path === "string" && typeof fields.mimeType === "string") {
    return new SelectedImage(value as never)
  }
  if (!(fields.data instanceof Uint8Array)) return undefined
  return new SelectedImage({
    dataOrBlobId: { case: "data", value: new Uint8Array(fields.data) },
    path: typeof fields.path === "string" ? fields.path : "",
    mimeType: typeof fields.mimeType === "string" ? fields.mimeType : "",
  })
}

function selectedVideoFromRunner(value: unknown): SelectedVideo | undefined {
  if (isSlateVideo(value)) return toInteropSelectedVideo(value)
  return isInteropSelectedVideo(value) ? value : undefined
}

function slateVideoFromPrompt(value: SlateTurnVideoInput): SlateVideoAttachment {
  if (isSlateVideo(value)) return value
  if (isInteropSelectedVideo(value)) return fromInteropSelectedVideo(value)
  return {
    sourcePath: value.path,
    displayName: value.filename ?? "",
    mediaType: "",
    writeToWorkspace: false,
    content: value.data === undefined ? { kind: "empty" } : { kind: "bytes", bytes: new Uint8Array(value.data) },
  }
}

/** Projects runner inputs into the generated prompt boundary while filtering malformed image/video attachments. */
export function interopTurnPromptOptionsFromRunner(options: RunnerTurnPromptOptionsInput): InteropTurnPromptOptions {
  const selectedImages = options.selectedImages?.flatMap((image) => {
    const selected = selectedImageFromRunner(image)
    return selected === undefined ? [] : [selected]
  });
  const selectedVideos = options.selectedVideos?.flatMap(video => {
    const selected = selectedVideoFromRunner(video)
    return selected === undefined ? [] : [selected]
  })
  return {
    ...(selectedImages === undefined ? {} : { selectedImages }),
    ...(selectedVideos === undefined ? {} : { selectedVideos }),
    ...(options.attachedFilePaths === undefined ? {} : { attachedFilePaths: options.attachedFilePaths }),
    ...(options.attachedFileSizes === undefined ? {} : { attachedFileSizes: options.attachedFileSizes }),
    ...(options.richText === undefined ? {} : { richText: options.richText }),
    ...(options.replyContext === undefined ? {} : { replyContext: options.replyContext }),
    ...(options.messageId === undefined ? {} : { messageId: options.messageId }),
    ...(options.automationWake === undefined ? {} : { automationWake: options.automationWake }),
    ...(options.isSilenceAllowed === undefined ? {} : { isSilenceAllowed: options.isSilenceAllowed }),
    ...(options.appendReplyReminder === undefined ? {} : { appendReplyReminder: options.appendReplyReminder }),
    ...(options.hidden === undefined ? {} : { hidden: options.hidden }),
    ...(options.recentUserMessages === undefined ? {} : { recentUserMessages: options.recentUserMessages }),
  };
}

/** Loads bytes for generated videos that a subagent must be able to review from disk. */
export async function hydrateInteropSelectedVideos(args: {
  readonly videos: readonly SelectedVideo[];
  readonly isSubagentRunner: boolean;
  readonly readBytes: (path: string) => Promise<Uint8Array | null>;
  readonly missingVideoError: (label: string) => Error;
}): Promise<SelectedVideo[]> {
  if (args.videos.length === 0 || !args.isSubagentRunner) return [...args.videos];
  const resolved: SelectedVideo[] = [];
  for (const video of args.videos) {
    if (video.dataOrBlobId.case !== undefined) {
      resolved.push(video);
      continue;
    }
    const videoPath = video.path.trim();
    const bytes = await args.readBytes(videoPath);
    if (bytes === null) throw args.missingVideoError(video.filename || (videoPath || "unknown"));
    resolved.push(new SelectedVideo({
      uuid: video.uuid,
      path: video.path,
      ...(video.fps === undefined ? {} : { fps: video.fps }),
      mimeType: video.mimeType,
      filename: video.filename,
      materializeToFilesystem: video.materializeToFilesystem,
      dataOrBlobId: { case: "data", value: bytes },
    }));
  }
  return resolved;
}

function slateMessageFromRunner(value: unknown): SlateUserMessage {
  if (value !== null && typeof value === "object" && !("toBinary" in value) && "text" in value) {
    const record = value as Partial<SlateUserMessageInput>
    if (typeof record.text === "string" || isRedactedString(record.text)) {
      return createSlateUserMessageInput(record as SlateUserMessageInput)
    }
  }
  const message = value instanceof UserMessage ? value : new UserMessage(value as never)
  return fromInteropUserMessage(message)
}

/** Builds Slate's first-party user-message action from prompt and attachment facts. */
export function slateTurnActionFromPrompt(args: {
  readonly text: string;
  readonly messageId?: string;
  readonly richText?: string;
  readonly selectedImages: readonly (SelectedImage | SlateImageAttachment | { readonly data: Uint8Array; readonly path?: string; readonly mimeType?: string })[];
  readonly selectedVideos: readonly SlateTurnVideoInput[];
  readonly prependUserMessages: readonly unknown[];
  readonly unansweredQuestionsNote?: string;
  readonly automationStatusReminder: string | null;
  readonly automationStatusCompactionEpoch: number;
}): SlateTurnActionAssembly {
  const selectedImages = args.selectedImages.map((image) => {
    if (image instanceof SelectedImage) return image
    if ("sourcePath" in image) return toInteropSelectedImage(image)
    return new SelectedImage({
      dataOrBlobId: { case: "data", value: new Uint8Array(image.data) },
      path: image.path ?? "",
      mimeType: image.mimeType ?? "",
    })
  });
  const selectedVideos = args.selectedVideos.map(video => toInteropSelectedVideo(slateVideoFromPrompt(video)))
  const selectedContextInterop = selectedImages.length > 0 || selectedVideos.length > 0
    ? new SelectedContext({ selectedImages, selectedVideos })
    : undefined;
  const selectedContext = selectedContextInterop === undefined
    ? undefined
    : fromInteropSelectedContextState(selectedContextInterop)
  const earlierMessages = args.prependUserMessages.map(slateMessageFromRunner)
  if (args.unansweredQuestionsNote !== undefined) {
    earlierMessages.push(createSlateUserMessageInput({ text: args.unansweredQuestionsNote }))
  }
  return {
    action: {
      kind: SlateAgentActionKind.USER_MESSAGE,
      payload: {
        schema: "slate.agent-action.user-message",
        version: 1,
        message: createSlateUserMessageInput({
          text: args.text,
          messageId: args.messageId ?? "",
          ...(args.richText === undefined ? {} : { richText: args.richText }),
          ...(selectedContext === undefined ? {} : { selectedContext }),
        }),
        earlierMessages,
        notifyUser: false,
      },
      context: { privacyMode: PrivacyMode.UNSPECIFIED },
    },
    automationStatusReminder: args.automationStatusReminder,
    automationStatusCompactionEpoch: args.automationStatusCompactionEpoch,
  };
}
