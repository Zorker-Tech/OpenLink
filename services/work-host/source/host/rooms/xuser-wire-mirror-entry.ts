import { normalizeSharedRoomName } from "../groups/xuser.ts";
import type { MirrorEntry } from "./xuser-wire-contracts.ts";
import { normalizeInlineImages } from "./xuser-wire-images.ts";
import { wireRecord } from "./xuser-wire-records.ts";

export function normalizeMirrorEntry(value: unknown, nowMs: number): MirrorEntry | null {
  const entry = wireRecord(value);
  if (entry == null || typeof entry.entryId !== "string" || entry.entryId.length === 0) return null;

  const text = typeof entry.text === "string" ? entry.text : "";
  const images = normalizeInlineImages(entry.images);
  if (text.length === 0 && images.length === 0) return null;
  const timestampMs = typeof entry.timestampMs === "number" && Number.isFinite(entry.timestampMs)
    ? entry.timestampMs
    : nowMs;

  if (entry.kind === "human-message") {
    if (typeof entry.authorAuthId !== "string" || entry.authorAuthId.length === 0) return null;
    return {
      kind: "human-message",
      entryId: entry.entryId,
      authorAuthId: entry.authorAuthId,
      authorName: normalizeSharedRoomName(typeof entry.authorName === "string" ? entry.authorName : ""),
      ...(typeof entry.authorAvatarUrl === "string" && entry.authorAvatarUrl.length > 0 ? { authorAvatarUrl: entry.authorAvatarUrl } : {}),
      text,
      images,
      ...(typeof entry.clientNonce === "string" && entry.clientNonce.length > 0 ? { clientNonce: entry.clientNonce } : {}),
      timestampMs,
    };
  }

  if (entry.kind === "agent-message") {
    if (typeof entry.agentOwnerAuthId !== "string" || entry.agentOwnerAuthId.length === 0) return null;
    if (typeof entry.agentId !== "string" || entry.agentId.length === 0) return null;
    return {
      kind: "agent-message",
      entryId: entry.entryId,
      agentOwnerAuthId: entry.agentOwnerAuthId,
      agentId: entry.agentId,
      authorName: normalizeSharedRoomName(typeof entry.authorName === "string" ? entry.authorName : ""),
      text,
      images,
      timestampMs,
    };
  }
  return null;
}
