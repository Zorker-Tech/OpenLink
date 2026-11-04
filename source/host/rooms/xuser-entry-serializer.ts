import { inlineRoomImages } from "./xuser-entry-images.ts";
import type { PublishableEntry, PublishedRoomEntry, XuserEntryPublisherHost } from "./xuser-entry-publisher-contracts.ts";
import {
  agentEntryContent,
  agentEntryIdentity,
  clientNonceField,
  humanEntryContent,
  humanEntryIdentity,
  roomTimestampField,
} from "./xuser-entry-projection.ts";
import { parseRemoteAgentId } from "./xuser-remote-agent-id.ts";

async function humanMessage(
  host: XuserEntryPublisherHost,
  entry: Extract<PublishableEntry, { kind: "message" }>,
  selfAuthId: string,
): Promise<PublishedRoomEntry | null> {
  if (entry.fromAgent != null || entry.toAgent != null || entry.channel != null || entry.fromUser != null) return null;
  if (entry.content.trim().length === 0) return null;

  return Object.assign(
    { kind: "human-message" },
    humanEntryIdentity(entry.id, selfAuthId),
    humanEntryContent(entry.content, await inlineRoomImages(host, entry.images)),
    clientNonceField(entry.clientNonce),
    roomTimestampField(entry.timestampMs, () => host.clock.now()),
  );
}

async function agentMessage(
  host: XuserEntryPublisherHost,
  entry: Extract<PublishableEntry, { kind: "send-message" }>,
  selfAuthId: string,
): Promise<PublishedRoomEntry | null> {
  if (entry.message.type !== "text" || entry.author == null || entry.streaming === true) return null;
  if (parseRemoteAgentId(entry.author.id) !== null) return null;

  return Object.assign(
    { kind: "agent-message" },
    agentEntryIdentity(entry.id, selfAuthId, entry.author.id, entry.author.name),
    agentEntryContent(entry.message.content, await inlineRoomImages(host, entry.message.images)),
    roomTimestampField(entry.timestampMs, () => host.clock.now()),
  );
}

export async function serializeRoomEntry(
  host: XuserEntryPublisherHost,
  entry: PublishableEntry,
  selfAuthId: string,
): Promise<PublishedRoomEntry | null> {
  if (entry.kind === "message" && "role" in entry && entry.role === "user") {
    return humanMessage(host, entry, selfAuthId);
  }
  if (entry.kind === "send-message" && "message" in entry) {
    return agentMessage(host, entry, selfAuthId);
  }
  return null;
}
