import { serializeRoomEntry } from "./xuser-entry-serializer.ts";
import type { PublishableEntry, XuserEntryPublisherHost } from "./xuser-entry-publisher-contracts.ts";

export async function deliverRoomEntry(
  host: XuserEntryPublisherHost,
  sharedRoomId: string,
  entry: PublishableEntry,
): Promise<void> {
  if (!host.isEnabled()) return;
  const selfAuthId = host.getSelfAuthId();
  if (selfAuthId == null) return;

  const wireEntry = await serializeRoomEntry(host, entry, selfAuthId);
  if (wireEntry === null) return;

  const result = await host.relay.send({ kind: "room-entry", roomId: sharedRoomId, entry: wireEntry });
  if (result.timestampMs !== undefined && result.timestampMs !== null) {
    await host.manager.restampRoomEntry({ roomId: sharedRoomId, entryId: entry.id, timestampMs: result.timestampMs });
  }
}
