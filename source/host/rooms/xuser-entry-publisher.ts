import { deliverRoomEntry } from "./xuser-entry-delivery.ts";
import { inlineRoomImages } from "./xuser-entry-images.ts";
import type { PublishableEntry, XuserEntryPublisherHost } from "./xuser-entry-publisher-contracts.ts";
import { enqueueRoomEntry } from "./xuser-entry-queue.ts";
import { serializeRoomEntry } from "./xuser-entry-serializer.ts";

export {
  SLATE_SHARED_ROOM_IMAGE_BYTES_MAX,
  type PublishableEntry,
  type PublishedRoomEntry,
  type RoomEntryRestamp,
  type XuserEntryPublisherHost,
} from "./xuser-entry-publisher-contracts.ts";
export { parseRemoteAgentId, REMOTE_AGENT_ID_PREFIX } from "./xuser-remote-agent-id.ts";

export class SlateXuserEntryPublisher {
  private readonly publishChains = new Map<string, Promise<void>>();

  constructor(readonly host: XuserEntryPublisherHost) {}

  enqueuePublish(sharedRoomId: string, entry: PublishableEntry): void {
    enqueueRoomEntry(this.publishChains, sharedRoomId, () => this.publishEntry(sharedRoomId, entry));
  }

  publishEntry(sharedRoomId: string, entry: PublishableEntry): Promise<void> {
    return deliverRoomEntry(this.host, sharedRoomId, entry);
  }

  serializeEntry(entry: PublishableEntry, selfAuthId: string): Promise<Record<string, unknown> | null> {
    return serializeRoomEntry(this.host, entry, selfAuthId);
  }

  inlineImages(images?: readonly { url: string; alt?: string }[]) {
    return inlineRoomImages(this.host, images);
  }
}
