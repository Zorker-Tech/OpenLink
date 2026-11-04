import {
  ConversationAction,
  UserMessage,
  UserMessageAction,
} from "../proto/generated/agent/v1/agent_pb.ts";
import {
  SelectedContext,
  SelectedImage,
  SelectedVideo,
} from "../proto/generated/agent/v1/selected_context_pb.ts";

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
  readonly selectedImages?: readonly { readonly data: Uint8Array; readonly path?: string; readonly mimeType?: string }[];
  readonly selectedVideos?: readonly SelectedVideo[];
  readonly recentUserMessages?: readonly { readonly id: string; readonly text: string; readonly richText?: string }[];
}

export interface InteropTurnActionAssembly {
  readonly action: ConversationAction;
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

/** Projects runner inputs into the generated prompt boundary while filtering malformed image/video attachments. */
export function interopTurnPromptOptionsFromRunner(options: RunnerTurnPromptOptionsInput): InteropTurnPromptOptions {
  const selectedImages = options.selectedImages?.flatMap((image) => {
    if (typeof image !== "object" || image === null) return [];
    const fields = image as Record<string, unknown>;
    if (!(fields.data instanceof Uint8Array)) return [];
    return [{
      data: fields.data,
      ...(typeof fields.path === "string" ? { path: fields.path } : {}),
      ...(typeof fields.mimeType === "string" ? { mimeType: fields.mimeType } : {}),
    }];
  });
  return {
    ...(selectedImages === undefined ? {} : { selectedImages }),
    ...(options.selectedVideos === undefined ? {} : { selectedVideos: options.selectedVideos.filter(isInteropSelectedVideo) }),
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

/** Encodes Slate prompt facts into the generated Agent action at the executor boundary. */
export function generatedTurnActionFromSlate(args: {
  readonly text: string;
  readonly messageId?: string;
  readonly richText?: string;
  readonly selectedImages: readonly { readonly data: Uint8Array; readonly path?: string; readonly mimeType?: string }[];
  readonly selectedVideos: readonly SelectedVideo[];
  readonly prependUserMessages: readonly unknown[];
  readonly unansweredQuestionsNote?: string;
  readonly automationStatusReminder: string | null;
  readonly automationStatusCompactionEpoch: number;
}): InteropTurnActionAssembly {
  const selectedImages = args.selectedImages.map((image) => new SelectedImage({
    dataOrBlobId: { case: "data", value: image.data },
    path: image.path ?? "",
    mimeType: image.mimeType ?? "",
  }));
  const selectedContext = selectedImages.length > 0 || args.selectedVideos.length > 0
    ? new SelectedContext({ selectedImages, selectedVideos: [...args.selectedVideos] })
    : undefined;
  const prependUserMessages = [...args.prependUserMessages] as UserMessage[];
  if (args.unansweredQuestionsNote !== undefined) prependUserMessages.push(new UserMessage({ text: args.unansweredQuestionsNote }));
  const userMessage = new UserMessage({
    text: args.text,
    messageId: args.messageId ?? "",
    ...(args.richText === undefined ? {} : { richText: args.richText }),
    ...(selectedContext === undefined ? {} : { selectedContext }),
  });
  return {
    action: new ConversationAction({ action: { case: "userMessageAction", value: new UserMessageAction({ userMessage, prependUserMessages }) } }),
    automationStatusReminder: args.automationStatusReminder,
    automationStatusCompactionEpoch: args.automationStatusCompactionEpoch,
  };
}
