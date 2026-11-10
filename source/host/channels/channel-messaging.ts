/**
 * Talking on a channel.
 *
 * A channel is somewhere outside this app, so the agent has to be told what that means: a message that arrives from a
 * channel wakes the agent with a cue that names where it came from and who sent it, a reply goes back to that channel
 * rather than to the app, and what only this app can show — a widget, a card — is degraded to text so the person on
 * the other side gets something they can read.
 */
import { clampLine } from "../../shared/slate-text.ts";
import {
  findConnectorManifest,
  formatChannelAddress,
  hasChannelsToShow,
  parseChannelAddress,
  type ChannelAddress,
  type ConnectorManifest,
} from "./channels.ts";

export const CHANNEL_CONFIG_FILENAME = "connection.json";
export const CHANNEL_MAX_LABEL_LENGTH = 80;
export const CHANNEL_INBOUND_WAKE_CUE = "[inbound]";
export const CHANNEL_DELIVERY_FAILED_WAKE_CUE = "[channel-delivery-failed]";
export const CHANNEL_CREDENTIAL_FIELD = "token";

export function clampChannelLabel(label: string): string {
  return clampLine(label, CHANNEL_MAX_LABEL_LENGTH);
}

export type ChannelOutboundInput =
  | {
      readonly type: "text";
      readonly content: string;
      readonly images?: readonly { readonly url: string }[];
    }
  | {
      readonly type: "attachment";
      readonly url: string;
      readonly alt?: string | null;
    }
  | { readonly type: string; readonly [key: string]: unknown };

export type ChannelOutboundMessage =
  | { readonly kind: "text"; readonly text: string }
  | {
      readonly kind: "attachment";
      readonly url: string;
      readonly caption: string | null;
    };

export function buildChannelOutboundMessage(
  message: ChannelOutboundInput,
): ChannelOutboundMessage | null {
  if (message.type === "text") {
    const text = message as Extract<ChannelOutboundInput, { type: "text" }>;
    const image = (text.images ?? []).find((candidate) => candidate.url.length > 0);
    if (image != null) {
      return {
        kind: "attachment",
        url: image.url,
        caption: text.content.length > 0 ? text.content : null,
      };
    }
    return text.content.length > 0 ? { kind: "text", text: text.content } : null;
  }
  if (message.type === "attachment") {
    const attachment = message as Extract<
      ChannelOutboundInput,
      { type: "attachment" }
    >;
    const caption =
      attachment.alt != null && attachment.alt.length > 0 ? attachment.alt : null;
    if (attachment.url.length > 0) {
      return { kind: "attachment", url: attachment.url, caption };
    }
    return caption != null ? { kind: "text", text: caption } : null;
  }
  return null;
}

export interface ChannelConnectionSummary {
  readonly platform: string;
  readonly label: string;
  readonly status: string;
  readonly detail?: string | null;
}

function linkLineOf(connection: ChannelConnectionSummary): string {
  const connector = findConnectorManifest(connection.platform);
  const connectorName = connector?.displayName ?? connection.platform;
  const detail =
    connection.status === "error" && connection.detail != null
      ? ` (${connection.detail})`
      : "";
  return `- ${connectorName} "${connection.label}" [${connection.status}]${detail}. Address people on it as ${connection.platform}:<chat id>`;
}

export function renderChannelsSystemPrompt(
  manifests: readonly ConnectorManifest[],
  linkedChannels: readonly ChannelConnectionSummary[],
  folder: string | null | undefined,
): string {
  if (folder == null) return "";
  if (!hasChannelsToShow(manifests, linkedChannels)) return "";
  const available = manifests.filter(
    (connector) => connector.availability === "available",
  );
  const outputLines = [
    "Channels: outside messaging surfaces you can talk on, beyond this Slate chat.",
    `Each connected channel lives in a subfolder at ${folder} holding a ${CHANNEL_CONFIG_FILENAME}. That file holds only a label, never a credential; the secret is kept in a separate store you cannot read. To disconnect one, prefer the update_state tool (target "channel", action "disconnect", the platform); a background connector notices and closes the live connection within a few seconds.`,
    "Never ask the user to paste a token, API key, or password into the chat, and never write one into a file: that would persist it in the transcript or somewhere you can read it back. To collect any credential, send a SendMessage of type secret-request (connector + field + a clear label). The user types it into a masked field and the value goes straight to the secret store; you only learn that it was provided, never the value. You do not need the credential to check status; never cat the connection file expecting one.",
    "Every conversation on a channel has an address shaped like platform:chat (e.g. slack:C12345). An address names one chat; that is all routing needs.",
    `INBOUND: when someone messages you on a connected channel, you are woken with a hidden message that opens with the cue ${CHANNEL_INBOUND_WAKE_CUE} and names the source address and sender. That is a real person reaching out on that platform, not the user typing in this app. Reply to them on that same channel by calling SendMessage with a channel target set to their address; if you instead omit the channel, your message goes to this in-app Slate chat (the user at their desk), not to them.`,
    `REACTIONS: the same ${CHANNEL_INBOUND_WAKE_CUE} cue also wakes you when someone reacts to one of your messages (e.g. ❤️). A reaction is a lightweight acknowledgement, not a question: you usually do not need to reply, only act on it if it is useful.`,
    "OUTBOUND: SendMessage takes an optional channel target. Set it to an address (e.g. slack:C12345) to deliver there; leave it off and the message lands in this in-app chat exactly as before. You choose where each message goes, so be deliberate: by default answer an inbound message on the channel it came from.",
    "Pace a channel reply exactly like the in-app chat: open with a quick one-line acknowledgement, then send each progress beat and the final result as its own SendMessage as it happens. Each SendMessage is delivered to the platform immediately as a separate message, so the person sees you respond in real time; never hold it all back for one long message at the end, the worst way to reply on a channel. Keep every one of those messages extra concise: a channel is a messaging app, so write the short, to-the-point messages a person texts, terser than your in-app replies. Lead with the answer, prefer one or two short sentences, and skip long multi-paragraph messages, exhaustive detail, and unprompted caveats; expand only if they ask.",
    "A channel only carries text and attachments, never the in-app widget or slate-agent cards (those render only in this app), so degrade them to text when the conversation is on a channel: ask a multiple-choice question as plain text with the options as a numbered list and tell them to reply with their choice; reference a Slate cloud agent as a plain https://slate.invalid/agents/<agentId> link instead of a card; and for an attachment pass either a local file:// path or an https URL: the file is uploaded to the platform so they receive the real image or file, never a path.",
    "Platforms you can connect:",
  ];
  for (const connector of available) {
    outputLines.push(`- ${connector.displayName}: ${connector.blurb}`);
    for (const guideLine of connector.connectGuide.split("\n")) {
      outputLines.push(`  ${guideLine}`);
    }
  }
  const comingSoon = manifests.filter(
    (connector) => connector.availability === "coming-soon",
  );
  if (comingSoon.length > 0) {
    outputLines.push(
      `Coming soon (not connectable yet): ${comingSoon
        .map((connector) => connector.displayName)
        .join(", ")}.`,
    );
  }
  if (linkedChannels.length > 0) {
    outputLines.push("Currently connected:");
    for (const connection of linkedChannels) outputLines.push(linkLineOf(connection));
  } else {
    outputLines.push(
      "No channels connected yet. Offer to connect one when it would help the user reach people where they already are.",
    );
  }
  return outputLines.join("\n");
}

export interface ChannelReaction {
  readonly emoji: string;
  readonly messageQuote?: string | null;
}

export interface ChannelInboundEnvelope {
  readonly address: ChannelAddress;
  readonly sender: string;
  readonly text: string;
  readonly reaction?: ChannelReaction | null;
}

export function formatChannelReactionSummary(reaction: ChannelReaction): string {
  if (reaction.messageQuote != null && reaction.messageQuote.length > 0) {
    return `reacted ${reaction.emoji} to your message: "${reaction.messageQuote}"`;
  }
  return `reacted ${reaction.emoji} to a message`;
}

export function buildChannelInboundWakePrompt(
  envelopes: readonly ChannelInboundEnvelope[],
): string {
  const byAddress = new Map<string, ChannelInboundEnvelope[]>();
  for (const envelope of envelopes) {
    const key = formatChannelAddress(envelope.address);
    const messages = byAddress.get(key) ?? [];
    messages.push(envelope);
    byAddress.set(key, messages);
  }
  const sections: string[] = [];
  for (const [addressToken, messages] of byAddress) {
    const [firstEnvelope] = messages;
    if (firstEnvelope == null) continue;
    const platform = findConnectorManifest(firstEnvelope.address.platform);
    const connectorName = platform?.displayName ?? firstEnvelope.address.platform;
    const transcript = messages
      .map((envelope) =>
        envelope.reaction != null
          ? `  ${envelope.sender} ${formatChannelReactionSummary(envelope.reaction)}`
          : `  ${envelope.sender}: ${envelope.text}`,
      )
      .join("\n");
    sections.push(`On ${connectorName}, from ${addressToken}:\n${transcript}`);
  }
  const hasPlainMessage = envelopes.some((envelope) => envelope.reaction == null);
  const countSuffix = envelopes.length === 1 ? "" : "s";
  const headline = hasPlainMessage
    ? `${CHANNEL_INBOUND_WAKE_CUE} New message${countSuffix} on a channel you are connected to.`
    : `${CHANNEL_INBOUND_WAKE_CUE} New reaction${countSuffix} on a channel you are connected to.`;
  const tail = hasPlainMessage
    ? "Reply to them by calling SendMessage with the channel target set to the address shown above. Open with a quick one-line acknowledgement first, then send progress and the result as separate messages as they happen, never one long message at the end. Keep each message short: this is a messaging app, so reply in brief, chat-style messages (lead with the answer, a sentence or two), not long ones. Keep working the rest of your task too, but do not leave them hanging."
    : "You don't need to reply; act on a reaction only if it's useful (e.g. acknowledge, adjust, or continue). If you do choose to respond, use SendMessage with the channel target shown above.";
  return [
    headline,
    "This is activity from someone on an outside platform, not the user typing in this app.",
    "",
    sections.join("\n\n"),
    "",
    tail,
  ].join("\n");
}

export function humanizeChannelDeliveryFailure(
  addressToken: string,
  rawMessage: string,
): string {
  const address = parseChannelAddress(addressToken);
  const connectorName =
    address != null
      ? (findConnectorManifest(address.platform)?.displayName ?? address.platform)
      : null;
  const stripped = rawMessage.trim();
  if (address == null || /not a valid channel address/i.test(stripped)) {
    return `"${addressToken}" isn't a valid channel address, so that message wasn't delivered.`;
  }
  if (stripped === "No channel delivery mechanism is registered.") {
    return "Channel messaging isn't available on this computer, so that message wasn't delivered.";
  }
  if (/no live .* connection/i.test(stripped)) {
    return `${connectorName} isn't connected on this computer, so that message wasn't delivered. Connect ${connectorName} (add its token) to send there.`;
  }
  return `Couldn't deliver that message to ${connectorName}: ${stripped}`;
}

export interface ChannelDeliveryFailure {
  readonly addressToken: string;
  readonly reason: string;
}

export function buildChannelDeliveryFailureWakePrompt(
  problems: readonly ChannelDeliveryFailure[],
): string {
  const outputLines = problems.map(
    (problem) => `- To ${problem.addressToken}: ${problem.reason}`,
  );
  const countSuffix = problems.length === 1 ? "" : "s";
  return [
    `${CHANNEL_DELIVERY_FAILED_WAKE_CUE} A message you tried to send to a channel did not go through.`,
    "This is a system notice about your own outbound send, not the user typing in this app. You may have already told the user it was sent, so correct the record.",
    ...outputLines,
    `Tell the user plainly here, in this in-app chat (a SendMessage with no channel target), that the message${countSuffix} didn't go through and why, so they aren't left believing it was delivered. Don't silently retry the same channel; if it isn't connected, offer to help connect it.`,
  ].join("\n");
}
