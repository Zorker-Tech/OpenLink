import type { InlineImage } from "./xuser-wire-normalization.ts";

export const SLATE_SHARED_ROOM_IMAGE_BYTES_MAX = 1_100_000;

export interface XuserEntryPublisherHost {
  readonly relay: { send(payload: unknown): Promise<{ timestampMs?: number }> };
  readonly manager: { restampRoomEntry(args: { roomId: string; entryId: string; timestampMs: number }): Promise<void> };
  readonly clock: { now(): number };
  isEnabled(): boolean;
  getSelfAuthId(): string | null;
  resolveAttachment(url: string): Promise<{ data: Uint8Array; mimeType: string } | null>;
}

export type PublishableEntry =
  | {
    id: string;
    kind: "message";
    role: string;
    content: string;
    fromAgent?: unknown;
    toAgent?: unknown;
    channel?: unknown;
    fromUser?: unknown;
    images?: readonly { url: string; alt?: string }[];
    clientNonce?: string;
    timestampMs?: number;
  }
  | {
    id: string;
    kind: "send-message";
    message: { type: string; content: string; images?: readonly { url: string; alt?: string }[] };
    author?: { id: string; name: string };
    streaming?: boolean;
    timestampMs?: number;
  }
  | { id: string; kind: string };

export type PublishedRoomEntry = Record<string, unknown>;
export type RoomEntryRestamp = { roomId: string; entryId: string; timestampMs: number };
export type InlineRoomImage = InlineImage;
