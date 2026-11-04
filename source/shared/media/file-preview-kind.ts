/** The kinds of file a surface can preview, and how a name is classified into one. */
import {
  AUDIO_MIME_FROM_EXTENSION,
  IMAGE_MIME_FROM_EXTENSION,
  VIDEO_MIME_FROM_EXTENSION,
} from "./media-extensions.ts";
import { attachmentExtension } from "./attachment-open-policy.ts";
import { isTextPreviewableName } from "./attachment-preview.ts";

export type FilePreviewKind =
  | "image"
  | "video"
  | "audio"
  | "pdf"
  | "table"
  | "json"
  | "markdown"
  | "docx"
  | "text"
  | "unknown";

type ExtensionGroup = readonly [kind: FilePreviewKind, extensions: readonly string[]]

const EXTENSIONS_BY_KIND: readonly ExtensionGroup[] = [
  ["image", Object.keys(IMAGE_MIME_FROM_EXTENSION).map(extension => extension.slice(1))],
  ["video", Object.keys(VIDEO_MIME_FROM_EXTENSION).map(extension => extension.slice(1))],
  ["audio", Object.keys(AUDIO_MIME_FROM_EXTENSION).map(extension => extension.slice(1))],
  ["pdf", ["pdf"]],
  ["table", ["csv", "tsv", "xlsx", "xls"]],
  ["json", ["json"]],
  ["markdown", ["md", "markdown", "mdx"]],
  ["docx", ["docx"]],
]

const EXPLICIT_EXTENSION_KINDS = new Map<string, FilePreviewKind>()
for (const [kind, extensions] of EXTENSIONS_BY_KIND) {
  for (const extension of extensions) {
    if (EXPLICIT_EXTENSION_KINDS.has(extension)) continue
    EXPLICIT_EXTENSION_KINDS.set(extension, kind)
  }
}

const BYTE_READ_PREVIEW_KINDS = new Set<FilePreviewKind>([
  "pdf",
  "table",
  "docx",
  "text",
  "json",
  "markdown",
])

export function getFilePreviewKind(nameOrPath: string): FilePreviewKind {
  const extension = attachmentExtension(nameOrPath);
  if (extension == null) return "unknown";
  const knownKind = EXPLICIT_EXTENSION_KINDS.get(extension);
  if (knownKind !== undefined) return knownKind;
  if (isTextPreviewableName(nameOrPath)) return "text";
  return "unknown";
}

export function previewKindNeedsBytes(kind: FilePreviewKind): boolean {
  return BYTE_READ_PREVIEW_KINDS.has(kind)
}
