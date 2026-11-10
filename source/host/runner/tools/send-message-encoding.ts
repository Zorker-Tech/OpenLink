import {
  attachmentMessageArgs,
  createSendMessageToolCall,
  textMessageArgs,
} from "../../../adapters/interop/agent/send-message-tool-protocol-adapter.ts";
import { summarizeProductMessage } from "./send-message-product-summaries.ts";
import { encodeTextContent, encodeMarkdownImageDestination } from "./send-message-markdown.ts";
import { resolveBoxMediaAttachment } from "./send-message-box-media.ts";
import type { BoxMediaAttachmentRequest, EncodableMessage } from "./send-message-encoding-contracts.ts";

export type { EncodableMessage, BoxMediaAttachmentRequest } from "./send-message-encoding-contracts.ts";
export { createSendMessageToolCall, encodeMarkdownImageDestination, encodeTextContent, resolveBoxMediaAttachment };

export function encodeSendMessage(message: EncodableMessage) {
  switch (message.type) {
    case "text":
      return textMessageArgs(encodeTextContent({
        content: String(message.content ?? ""),
        ...(Array.isArray(message.images) ? { images: message.images as readonly { url: string; alt?: string }[] } : {}),
      }));
    case "attachment":
      return attachmentMessageArgs(String(message.url ?? ""), typeof message.alt === "string" ? message.alt : undefined);
    case "slate-agent": {
      const title = typeof message.title === "string" ? message.title.trim() : "";
      const agentId = String(message.agentId ?? "");
      const cardLabel = title.length > 0 ? ` (${title})` : "";
      return textMessageArgs(`Referenced Slate cloud agent ${agentId}${cardLabel}`);
    }
    default: {
      const summary = summarizeProductMessage(message);
      if (summary !== undefined) return textMessageArgs(summary);
      throw new Error(`Unsupported send-message type: ${message.type}`);
    }
  }
}
