/** A reversible emoji reaction an agent may add to a user's message. */
import { z } from "zod";
import { isMessageAddress } from "../../../shared/message-reference.ts";
import { defineCommunicateTool } from "./communicate-tool.ts";
import type { Context } from "../../../packages/context/context.ts";

export const SLATE_REACT_TO_MESSAGE_TOOL_NAME = "ReactToMessage";

const REACTION_DESCRIPTION = [
  "Add an emoji reaction to one message written by the user.",
  "Choose it only when that fits better than a reply; it never replaces an answer the user asked for.",
  "Use the address shown on a user's message, never one for something you sent.",
  "Sending the same emoji to the same message again removes the reaction.",
  "This action runs in the background and leaves the current turn open.",
  "Follow the user's emoji habits. If they rarely use emoji, skip reactions.",
].join(" ");

export const reactToMessageParameters = z.object({
  message_address: z.string().trim().min(1).describe(
    "The visible address tag on the user's message. Use it to select the message for the reaction.",
  ),
  emoji: z.string().trim().min(1).max(16).describe(
    "A short emoji reaction, trimmed and capped at 16 characters.",
  ),
});

export interface ReactToMessageDependencies {
  react(args: { readonly messageAddress: string; readonly emoji: string }): void;
}

interface ReactionRequest {
  readonly messageAddress: string;
  readonly emoji: string;
}

function prepareReactionRequest(addressText: string, emojiText: string):
  | { readonly ok: true; readonly request: ReactionRequest }
  | { readonly ok: false; readonly explanation: string } {
  const messageAddress = addressText.trim();
  if (!isMessageAddress(messageAddress)) {
    return {
      ok: false,
      explanation: `"${messageAddress}" is not a valid message address. Use the address shown on the user's message.`,
    };
  }
  return { ok: true, request: { messageAddress, emoji: emojiText.trim() } };
}

function describeReaction(request: ReactionRequest): string {
  return `Added ${request.emoji} to ${request.messageAddress}. Send that emoji again to remove it.`;
}

export function createReactToMessageTool<Dependencies extends ReactToMessageDependencies>(
  dependencies: Dependencies,
) {
  return defineCommunicateTool(dependencies, {
    id: "SEND_TO_USER",
    name: SLATE_REACT_TO_MESSAGE_TOOL_NAME,
    description: REACTION_DESCRIPTION,
    parameters: reactToMessageParameters,
    async execute(
      _context: Context,
      args: z.infer<typeof reactToMessageParameters>,
      resolved,
    ) {
      const prepared = prepareReactionRequest(args.message_address, args.emoji);
      if (!prepared.ok) return prepared.explanation;

      resolved.react(prepared.request);
      return describeReaction(prepared.request);
    },
  });
}
