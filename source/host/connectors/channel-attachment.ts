/**
 * An attachment that arrived through a channel.
 *
 * What a channel sends is an address or a path. An http(s) address is passed on as it is; anything else is turned into
 * a path the platform can read — re-anchored to the store the platform reads from, checked to be a file of a size worth
 * sending, and read only then. What the file is comes from what it is called, never from what the sender said.
 */

import { promises as fs } from "node:fs";
import { basename } from "node:path";
import { fileURLToPath } from "node:url";
import { reanchorSlatePath } from "../host-paths.ts";
import { imageMimeFromPath, videoMimeFromPath } from "../../shared/media/image-mime.ts";

export const CHANNEL_ATTACHMENT_MAX_UPLOAD_BYTES = 50 * 1024 * 1024;
export const GENERIC_BINARY_MIME = "application/octet-stream";

export type ResolvedChannelAttachment =
  | { readonly transport: "url"; readonly isImage: boolean; readonly url: string }
  | { readonly transport: "upload"; readonly isImage: boolean; readonly bytes: Uint8Array; readonly filename: string; readonly mime: string };

function parseUrl(raw: string): URL | null {
  try {
    return new URL(raw);
  } catch {
    return null;
  }
}

/** The path a channel's address points at, when it points at a file on this machine. */
export function toLocalChannelAttachmentPath(raw: string): string | null {
  const parsed = parseUrl(raw);
  if (parsed == null) return raw.length > 0 ? raw : null;
  if (parsed.protocol !== "file:") return null;
  try {
    return fileURLToPath(parsed);
  } catch {
    return null;
  }
}

export function urlLooksLikeImage(raw: string): boolean {
  const parsed = parseUrl(raw);
  return parsed != null && imageMimeFromPath(parsed.pathname) != null;
}

export async function resolveChannelAttachment(
  rawUrl: unknown,
  deps: { readonly reanchor?: (path: string) => string; readonly stat?: typeof fs.stat; readonly readFile?: typeof fs.readFile } = {},
): Promise<ResolvedChannelAttachment | null> {
  if (typeof rawUrl !== "string" || rawUrl.length === 0) return null;
  const parsed = parseUrl(rawUrl);
  // An address the receiver can fetch itself is handed on as it is.
  if (parsed?.protocol === "https:" || parsed?.protocol === "http:") {
    return { transport: "url", isImage: urlLooksLikeImage(rawUrl), url: rawUrl };
  }
  const localPath = toLocalChannelAttachmentPath(rawUrl);
  if (localPath == null) return null;
  const resolved = (deps.reanchor ?? reanchorSlatePath)(localPath);
  let size: number;
  try {
    const stats = await (deps.stat ?? fs.stat)(resolved);
    if (!stats.isFile()) return null;
    size = stats.size;
  } catch {
    return null;
  }
  // An empty file is not worth sending, and one past the bound is not one to read at all.
  if (size === 0 || size > CHANNEL_ATTACHMENT_MAX_UPLOAD_BYTES) return null;
  let data: Buffer;
  try {
    data = await (deps.readFile ?? fs.readFile)(resolved);
  } catch {
    return null;
  }
  const imageMime = imageMimeFromPath(resolved);
  return {
    transport: "upload",
    isImage: imageMime != null,
    bytes: new Uint8Array(data),
    filename: basename(resolved),
    mime: imageMime ?? videoMimeFromPath(resolved) ?? GENERIC_BINARY_MIME,
  };
}
