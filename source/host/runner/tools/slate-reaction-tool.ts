/**
 * The tool an agent reacts to a message with.
 *
 * The message is named the way the platform addresses messages, and the reaction is one the channel's own rules
 * allow, so an agent cannot react to something that is not a message or with something the platform cannot send.
 */
import { z } from "zod";
import { isMessageAddress } from "../../../shared/message-reference.ts";
import { defineCommunicateTool } from "./communicate-tool.ts";
import type { Context } from "../../../packages/context/context.ts";

export const SLATE_REACT_TO_MESSAGE_TOOL_NAME = "ReactToMessage";

export const reactToMessageParameters = z.object({
  message_address: z.string().trim().min(1).describe(
    "The address of the USER message to react to — the [t3u]-style tag shown on their message. Only the user's own messages, never your own sends.",
  ),
  emoji: z.string().trim().min(1).max(16).describe(
    "A single common emoji to react with, e.g. \u{1F44D}, \u2764\uFE0F, \u{1F602}, \u{1F389}.",
  ),
});

export interface ReactToMessageDependencies {
  react(args: { readonly messageAddress: string; readonly emoji: string }): void;
}

export function createReactToMessageTool<Dependencies extends ReactToMessageDependencies>(
  dependencies: Dependencies,
) {
  return defineCommunicateTool(dependencies, {
    id: "SEND_TO_USER",
    name: SLATE_REACT_TO_MESSAGE_TOOL_NAME,
    description: "React to one of the USER's messages with a single emoji tapback (like an iMessage reaction), attributed to you and shown as a small pill on their message. Use this VERY sparingly, only when a reaction is the genuinely natural, human response and a reply would be overkill: they said something funny, shared good news, or a quick \u{1F44D} fits better than a sentence. It is NOT a substitute for a real reply when they asked you for something, and you never react just to seem friendly. Only react to the user's own messages (their [t3u]-style address), never your own sends. It toggles: reacting the same emoji to the same message again removes your reaction, which is how you take one back. Fire-and-forget: it doesn't end your turn and returns nothing to act on. Mirror the user \u2014 if they don't use emoji, basically never do this.",
    parameters: reactToMessageParameters,
    async execute(
      _context: Context,
      args: z.infer<typeof reactToMessageParameters>,
      resolved,
    ) {
      const address = args.message_address.trim();
      if (!isMessageAddress(address)) {
        return `"${address}" isn't a valid message address. React with the [t3u]-style tag shown on the user's message.`;
      }
      const emoji = args.emoji.trim();
      resolved.react({ messageAddress: address, emoji });
      return `Reacted ${emoji} on ${address}. (Reactions toggle: react the same emoji again to take it back.)`;
    },
  });
}
