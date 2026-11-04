/** Compose and deliver the messages that appear in a Slate conversation. */

import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

import {
  createSendMessageProtocolCall,
  sendMessageErrorResult,
  sendMessageSuccessResult,
  type InteropSendMessageResult,
} from "../../../adapters/interop/agent/send-message-tool-protocol-adapter.ts";
import type { Context } from "../../../packages/context/context.ts";
import { createStringResult } from "../../../packages/chat-inference/prompt-executor.ts";
import { createZodAgentTool, withSafeParsedArgs } from "../../../packages/agent/tools/tool-support.ts";
import { encodeSendMessage } from "./send-message-encoding.ts";
import { sendMessageParameters, type SendMessageInput } from "./send-message-schema.ts";
import { clampSecretDescription, clampSecretLabel } from "./slate-secret-request.ts";
import { SlateToolInputError } from "./tool-input-error.ts";

export const SLATE_SEND_MESSAGE_TOOL_NAME = "SendMessage";

const SLATE_SEND_MESSAGE_TOOL_DESCRIPTION = [
  "Use SendMessage for every reply or result the user should see. Plain assistant text is private and is not delivered.",
  "Share meaningful progress after a result, decision, blocker, or plan change. Combine routine mechanics and retries, and do not leave the user waiting through a long task.",
  "Choose text for conversation. Put images that accompany words on the same text message, and do not use Markdown image syntax. Use attachment for a standalone image, video, or other file. File URLs must be absolute; HTTPS links are accepted.",
  "Use reply_to to thread a reply. A slate-msg reference link jumps to an earlier message without starting a thread; include one only when it helps.",
  "Use slate-agent with its bcId to refer to a remote Slate agent. In visible text, use its name or say remote agent; never paste an agent URL or identifier.",
  "Use widget sparingly for a consequential choice or ambiguity only the user can resolve. Ask a natural question and offer one to six verified, real choices. Add help text when it clarifies the choice; each option may have a value, description, and style. Enable allowCustom only when a typed answer is useful. Enable dismissOnMoveOn only for a low-stakes question. After sending a widget, stop. If the user dismisses it, treat that as a decline and do not ask again.",
  "Use secret-request for credentials. It opens a masked secure input; never ask the user to paste a secret into chat, and do not expect to see its value.",
  "When an operating-system permission prompt is needed, attempt the action and let the system show it. For a login, SSO, second factor, CAPTCHA, or payment that only the user can complete, use request_box_help.",
].join(" ");

export const SLATE_AWAITING_USER_SEND_MESSAGE_BLOCKED =
  "This turn is waiting for the user to answer a question or continue from a handoff. The message was not sent; wait for their reply before continuing.";

export interface SlateOutgoingMessage extends Record<string, unknown> {
  readonly type: SendMessageInput["type"];
}

export interface SendMessageDependencies<Context> {
  readonly isAwaitingUserSelection?: () => boolean;
  readonly resolveCloudAgentTitle?: (ctx: Context, bcId: string) => Promise<string | undefined>;
  readonly getIngestAttachment: () => ((sourcePath: string) => Promise<string>) | undefined;
  readonly resolveBoxAttachment?: (ctx: Context, sourcePath: string) => Promise<string | null>;
  readonly readMediaDimensions?: (sourcePath: string) => Promise<{ width: number; height: number } | null>;
  readonly classifyAttachment?: (url: string) => "file" | "media";
  readonly onSendMessage: (message: SlateOutgoingMessage, timestampMs: number) => string | undefined;
}

function localPathFromUrl(value: string): string | null {
  try {
    const url = new URL(value);
    return url.protocol === "file:" ? fileURLToPath(url) : null;
  } catch {
    return null;
  }
}

export async function resolveAttachmentSource<Context>(
  ctx: Context,
  sourceUrl: string,
  dependencies: SendMessageDependencies<Context>,
): Promise<{ url: string; fileName?: string }> {
  const sourcePath = localPathFromUrl(sourceUrl);
  if (sourcePath === null) return { url: sourceUrl };

  const fileName = path.basename(sourcePath);
  const result = (url: string) => ({ url, ...(fileName.length === 0 ? {} : { fileName }) });
  const ingest = dependencies.getIngestAttachment();
  if (ingest !== undefined) {
    try {
      const cachedPath = await ingest(sourcePath);
      return result(pathToFileURL(cachedPath).href);
    } catch {
      // The box resolver is the next available route for a local attachment.
    }
  }

  const boxUrl = await dependencies.resolveBoxAttachment?.(ctx, sourcePath);
  return result(boxUrl ?? sourceUrl);
}

async function mediaDimensions<Context>(
  url: string,
  dependencies: SendMessageDependencies<Context>,
): Promise<{ width: number; height: number } | undefined> {
  const filePath = localPathFromUrl(url);
  if (filePath === null || dependencies.readMediaDimensions === undefined) return undefined;
  return await dependencies.readMediaDimensions(filePath) ?? undefined;
}

function replyAddress(input: SendMessageInput): string | undefined {
  return input.reply_to || undefined;
}

function channelAddress(input: SendMessageInput): string | undefined {
  return input.channel || undefined;
}

async function composeTextMessage<Context>(
  ctx: Context,
  input: SendMessageInput,
  dependencies: SendMessageDependencies<Context>,
): Promise<SlateOutgoingMessage> {
  const images = [];
  for (const image of input.images ?? []) {
    const source = await resolveAttachmentSource(ctx, image.url, dependencies);
    images.push({
      url: source.url,
      ...(image.alt ? { alt: image.alt } : {}),
      ...await mediaDimensions(source.url, dependencies),
    });
  }

  const replyTo = replyAddress(input);
  const channel = channelAddress(input);
  return {
    type: "text",
    content: input.content ?? "",
    ...(images.length === 0 ? {} : { images }),
    ...(replyTo === undefined ? {} : { reply_to: replyTo }),
    ...(channel === undefined ? {} : { channel }),
  };
}

async function composeAttachmentMessage<Context>(
  ctx: Context,
  input: SendMessageInput,
  dependencies: SendMessageDependencies<Context>,
): Promise<SlateOutgoingMessage> {
  const url = input.url ?? "";
  try {
    if (new URL(url).protocol === "https:" && dependencies.classifyAttachment?.(url) === "file") {
      const replyTo = replyAddress(input);
      const channel = channelAddress(input);
      return {
        type: "text",
        content: url,
        ...(replyTo === undefined ? {} : { reply_to: replyTo }),
        ...(channel === undefined ? {} : { channel }),
      };
    }
  } catch {
    // Validation normally rejects malformed URLs; keep shaping safe for direct callers too.
  }

  const source = await resolveAttachmentSource(ctx, url, dependencies);
  const replyTo = replyAddress(input);
  const channel = channelAddress(input);
  return {
    type: "attachment",
    url: source.url,
    ...(replyTo === undefined ? {} : { reply_to: replyTo }),
    ...(source.fileName === undefined ? {} : { file_name: source.fileName }),
    ...(input.alt ? { alt: input.alt } : {}),
    ...(channel === undefined ? {} : { channel }),
    ...await mediaDimensions(source.url, dependencies),
  };
}

async function composeSlateAgentReference<Context>(
  ctx: Context,
  input: SendMessageInput,
  dependencies: SendMessageDependencies<Context>,
): Promise<SlateOutgoingMessage> {
  const bcId = input.bcId ?? "";
  if (bcId.length === 0) throw new SlateToolInputError("bcId is required for a slate-agent message");

  let title: string | undefined;
  try {
    title = (await dependencies.resolveCloudAgentTitle?.(ctx, bcId))?.trim() || undefined;
  } catch {
    title = undefined;
  }

  const replyTo = replyAddress(input);
  return {
    type: "slate-agent",
    bcId,
    ...(title === undefined ? {} : { title }),
    ...(replyTo === undefined ? {} : { reply_to: replyTo }),
  };
}

function composeSecretRequest(input: SendMessageInput): SlateOutgoingMessage {
  const secret = input.secret;
  if (secret == null) throw new SlateToolInputError("secret is required for a secret-request message");

  const replyTo = replyAddress(input);
  return {
    type: "secret-request",
    secretRequest: {
      label: clampSecretLabel(secret.label),
      ...(secret.description ? { description: clampSecretDescription(secret.description) } : {}),
      target: { kind: "channel-credential", platform: secret.connector, field: secret.field },
    },
    ...(replyTo === undefined ? {} : { reply_to: replyTo }),
  };
}

export async function buildSlateSendMessage<Context>(
  ctx: Context,
  input: SendMessageInput,
  dependencies: SendMessageDependencies<Context>,
): Promise<SlateOutgoingMessage> {
  const parsed = sendMessageParameters.parse(input);
  switch (parsed.type) {
    case "text":
      return await composeTextMessage(ctx, parsed, dependencies);
    case "widget": {
      if (parsed.widget == null) throw new SlateToolInputError("widget is required for a widget message");
      const replyTo = replyAddress(parsed);
      return { type: "widget", widget: parsed.widget, ...(replyTo === undefined ? {} : { reply_to: replyTo }) };
    }
    case "slate-agent":
      return await composeSlateAgentReference(ctx, parsed, dependencies);
    case "secret-request":
      return composeSecretRequest(parsed);
    case "attachment":
      return await composeAttachmentMessage(ctx, parsed, dependencies);
  }
}

export interface SendMessageInteractionHandler<Context> {
  emitPartialToolCall(context: Context, toolCallId: string, toolCall: unknown): void;
  executeToolCall<Result>(
    context: Context,
    initial: unknown,
    toolCallId: string,
    execute: (context: Context) => Promise<Result>,
    complete: (result: Result) => unknown,
  ): Promise<Result>;
}

export function createSendMessageTool(dependencies: SendMessageDependencies<Context>) {
  const execute = async (
    ctx: Context,
    rawHandler: unknown,
    rawInput: unknown,
    meta: { readonly toolCallId: string },
  ): Promise<InteropSendMessageResult> => {
    const interaction = rawHandler as SendMessageInteractionHandler<Context>;
    const message = await buildSlateSendMessage(ctx, rawInput as SendMessageInput, dependencies);
    const args = encodeSendMessage(message);

    const deliver = async (): Promise<InteropSendMessageResult> => {
      if (dependencies.isAwaitingUserSelection?.() === true) {
        return sendMessageErrorResult(SLATE_AWAITING_USER_SEND_MESSAGE_BLOCKED);
      }
      const timestampMs = Date.now();
      const messageId = dependencies.onSendMessage(message, timestampMs);
      return sendMessageSuccessResult(timestampMs, messageId);
    };

    return await interaction.executeToolCall(
      ctx,
      createSendMessageProtocolCall(args),
      meta.toolCallId,
      deliver,
      (result) => createSendMessageProtocolCall(args, result),
    );
  };

  return createZodAgentTool("SEND_MESSAGE", {
    name: SLATE_SEND_MESSAGE_TOOL_NAME,
    descriptionGenerator: () => SLATE_SEND_MESSAGE_TOOL_DESCRIPTION,
    parameters: sendMessageParameters,
    execute: withSafeParsedArgs(
      sendMessageParameters,
      execute,
      createSendMessageProtocolCall(),
    ),
    async render(_context: Context, output: InteropSendMessageResult) {
      if (output.result.case === "error") {
        const detail = output.result.value.error.trim();
        const message = detail.length === 0
          ? "The message could not be sent."
          : `The message could not be sent: ${detail}`;
        return createStringResult(message, true);
      }

      const messageId = output.result.case === "success" ? output.result.value.messageId.trim() : "";
      return createStringResult(messageId.length === 0 ? "Message sent to the user." : `Message sent to the user. (id: ${messageId})`);
    },
    serializeError(error: unknown) {
      const detail = error instanceof Error ? error.message : "Unexpected failure";
      return createSendMessageProtocolCall(undefined, sendMessageErrorResult(detail));
    },
  });
}
