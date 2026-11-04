/** Reduces transcript entries to the small rows the local index stores. */
import { basename, extname } from "node:path";
import { classifyAttachment } from "../../../shared/media/attachment-summary.ts";
import { audioMimeFromPath, imageMimeFromPath, videoMimeFromPath } from "../../../shared/media/image-mime.ts";
import type { AttachmentKind } from "./search-index-db.ts";
import { INDEXED_BODY_MAX_CHARS, type IndexEntry, type ProjectedMedia, type ProjectedMessage } from "./search-index-writer-contracts.ts";

function timestampOf(value: unknown): number {
  return typeof value === "number" && Number.isFinite(value) ? Math.round(value) : 0;
}

function dimensionOf(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? Math.round(value) : null;
}

function textualContent(entry: IndexEntry): string {
  switch (entry.kind) {
    case "message":
      return entry.content ?? "";
    case "send-message":
      return entry.message?.type === "text" ? entry.message.content ?? "" : "";
    case "notice":
      return entry.text ?? "";
    default:
      return "";
  }
}

export function projectMessage(entry: IndexEntry): ProjectedMessage | null {
  if (entry.kind === "message" && entry.toAgent != null && entry.toAgent.kind !== "agent") return null;
  const body = textualContent(entry).trim();
  if (body.length === 0) return null;
  return {
    entryId: entry.id,
    role: entry.kind === "message" ? entry.role ?? "assistant" : "assistant",
    timestampMs: timestampOf(entry.timestampMs),
    body: body.slice(0, INDEXED_BODY_MAX_CHARS),
  };
}

function pathName(fileName: string | undefined, source: string): string {
  const explicitName = fileName?.trim();
  if (explicitName !== undefined && explicitName.length > 0) return explicitName;
  let candidate = source;
  try {
    candidate = new URL(source).pathname;
  } catch {
    // Paths can be local file names rather than URLs.
  }
  try {
    candidate = decodeURIComponent(candidate);
  } catch {
    // Keep the undecoded path when it contains an invalid escape sequence.
  }
  return basename(candidate);
}

export function projectMedia(entry: IndexEntry): ProjectedMedia | null {
  let source: string;
  let suppliedName: string | undefined;
  let width: number | null = null;
  let height: number | null = null;

  if (entry.kind === "user-attachment" && typeof entry.file_path === "string") {
    source = entry.file_path;
    suppliedName = entry.file_name;
    width = dimensionOf(entry.width);
    height = dimensionOf(entry.height);
  } else if (entry.kind === "send-message" && entry.message?.type === "attachment" && typeof entry.message.url === "string") {
    source = entry.message.url;
    suppliedName = entry.message.file_name;
  } else {
    return null;
  }

  const fileName = pathName(suppliedName, source);
  if (fileName.length === 0) return null;
  return {
    entryId: entry.id,
    fileName,
    ext: extname(fileName).toLowerCase(),
    mime: imageMimeFromPath(fileName) ?? videoMimeFromPath(fileName) ?? audioMimeFromPath(fileName) ?? null,
    kind: classifyAttachment({ fileName, urlOrPath: source }) as AttachmentKind,
    timestampMs: timestampOf(entry.timestampMs),
    width,
    height,
  };
}
