/**
 * The attachments a message carries.
 *
 * An attachment is a file the user handed over, described well enough for a surface to show it and for the platform to
 * fetch it: its name, its media type, its size and where it came from. What is bounded is bounded here — the count, the
 * size of a name and of a media type — so a message cannot be made unbounded by what it carries.
 */
export const SLATE_ATTACHMENT_KINDS = [
  "image", "video", "audio", "pdf", "markdown", "table", "json", "text", "document", "archive", "file",
] as const;

export type SlateAttachmentKind = (typeof SLATE_ATTACHMENT_KINDS)[number];
export interface AttachmentKindCount { readonly kind: string; readonly count: number }

const KIND_LABELS: Readonly<Record<SlateAttachmentKind, { readonly singular: string; readonly plural: string }>> = {
  image: { singular: "image", plural: "images" },
  video: { singular: "video", plural: "videos" },
  audio: { singular: "audio file", plural: "audio files" },
  pdf: { singular: "PDF", plural: "PDFs" },
  markdown: { singular: "Markdown file", plural: "Markdown files" },
  table: { singular: "spreadsheet", plural: "spreadsheets" },
  json: { singular: "JSON file", plural: "JSON files" },
  text: { singular: "text file", plural: "text files" },
  document: { singular: "document", plural: "documents" },
  archive: { singular: "archive", plural: "archives" },
  file: { singular: "file", plural: "files" },
};

export function kindPhrase(kind: SlateAttachmentKind, count: number): string {
  const label = KIND_LABELS[kind];
  return `${count} ${count === 1 ? label.singular : label.plural}`;
}

export function mergeKindCounts(kinds: readonly AttachmentKindCount[] | null | undefined): Array<{ kind: SlateAttachmentKind; count: number }> {
  if (kinds == null || kinds.length === 0) return [];
  const known = kinds
    .filter((entry) => entry.count > 0)
    .map((entry) => Object.hasOwn(KIND_LABELS, entry.kind)
      ? { kind: entry.kind as SlateAttachmentKind, count: entry.count }
      : { kind: "file" as const, count: entry.count });
  const merged = new Map<SlateAttachmentKind, number>();
  for (const entry of known) merged.set(entry.kind, (merged.get(entry.kind) ?? 0) + entry.count);
  return [...merged].map(([kind, count]) => ({ kind, count }));
}

export function formatAttachmentSentSummary(count: number, kinds?: readonly AttachmentKindCount[] | null): string {
  const total = Math.max(1, Math.floor(count));
  const merged = mergeKindCounts(kinds);
  if (merged.length === 0) return `Sent ${kindPhrase("file", total)}`;
  const first = merged[0];
  if (merged.length === 1 && first != null) return `Sent ${kindPhrase(first.kind, total)}`;
  const breakdown = merged.map((entry) => kindPhrase(entry.kind, entry.count)).join(", ");
  return `Sent ${kindPhrase("file", total)} · ${breakdown}`;
}
