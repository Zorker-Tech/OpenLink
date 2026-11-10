/** Translate Slate message deliveries into the executor's generated message envelopes. */

import { ToolCall } from "../proto/generated/agent/v1/agent_pb.ts";
import {
  SendMessageArgs,
  SendMessageAttachment,
  SendMessageError,
  SendMessageResult,
  SendMessageSuccess,
  SendMessageText,
  SendMessageToolCall,
} from "../proto/generated/agent/v1/send_message_tool_pb.ts";

export type InteropSendMessageResult = SendMessageResult;

export function createSendMessageToolCall(toolCall: SendMessageToolCall): ToolCall {
  return new ToolCall({ tool: { case: "sendMessageToolCall", value: toolCall } });
}

export function createSendMessageProtocolCall(
  args?: SendMessageArgs,
  result?: SendMessageResult,
): ToolCall {
  return createSendMessageToolCall(new SendMessageToolCall({
    ...(args === undefined ? {} : { args }),
    ...(result === undefined ? {} : { result }),
  }));
}

export function textMessageArgs(content: string): SendMessageArgs {
  return new SendMessageArgs({ message: { case: "text", value: new SendMessageText({ content }) } });
}

export function attachmentMessageArgs(url: string, alt: string | undefined): SendMessageArgs {
  return new SendMessageArgs({
    message: {
      case: "attachment",
      value: new SendMessageAttachment({ url, ...(alt === undefined ? {} : { alt }) }),
    },
  });
}

export function sendMessageErrorResult(error: string): SendMessageResult {
  return new SendMessageResult({
    result: { case: "error", value: new SendMessageError({ error }) },
  });
}

export function sendMessageSuccessResult(timestampMs: number, messageId: string | undefined): SendMessageResult {
  return new SendMessageResult({
    result: {
      case: "success",
      value: new SendMessageSuccess({
        timestamp: BigInt(timestampMs),
        ...(messageId == null || messageId.length === 0 ? {} : { messageId }),
      }),
    },
  });
}
