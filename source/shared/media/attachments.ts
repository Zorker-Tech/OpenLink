/**
 * The attachments a message carries.
 *
 * An attachment is a file the user handed over, described well enough for a surface to show it and for the platform to
 * fetch it: its kind, how many of it there are, and how one of them is said. What is bounded is bounded here — the
 * kinds this build names — so a message cannot be described with a kind nobody can read.
 */
export const SLATE_ATTACHMENT_KINDS = [
  "image", "video", "audio", "pdf", "markdown", "table", "json", "text", "document", "archive", "file",
] as const;

export type SlateAttachmentKind = (typeof SLATE_ATTACHMENT_KINDS)[number];

export interface AttachmentKindCount {
  readonly kind: string;
  readonly count: number;
}

/** How one of each kind is said: the singular first, the plural second. */
const KIND_LABELS: Readonly<Record<SlateAttachmentKind, readonly [string, string]>> = {
  image: ["image", "images"],
  video: ["video", "videos"],
  audio: ["audio file", "audio files"],
  pdf: ["PDF", "PDFs"],
  markdown: ["Markdown file", "Markdown files"],
  table: ["spreadsheet", "spreadsheets"],
  json: ["JSON file", "JSON files"],
  text: ["text file", "text files"],
  document: ["document", "documents"],
  archive: ["archive", "archives"],
  file: ["file", "files"],
};

/** A kind this build names, or the one kind that stands for everything else. */
function namedKind(kind: string): SlateAttachmentKind {
  return Object.hasOwn(KIND_LABELS, kind) ? (kind as SlateAttachmentKind) : "file";
}

/** How many of one kind are said: "1 image", "3 images". */
export function kindPhrase(kind: SlateAttachmentKind, count: number): string {
  const [one, many] = KIND_LABELS[kind];
  return `${count} ${count === 1 ? one : many}`;
}

/**
 * The counts a summary shows: one entry per kind, the kinds this build does not name counted as files, and kinds that
 * were not counted left out.
 */
export function mergeKindCounts(kinds: readonly AttachmentKindCount[] | null | undefined): Array<{ kind: SlateAttachmentKind; count: number }> {
  if (kinds == null || kinds.length === 0) return [];
  const merged = new Map<SlateAttachmentKind, number>();
  for (const entry of kinds) {
    if (entry.count <= 0) continue;
    const kind = namedKind(entry.kind);
    merged.set(kind, (merged.get(kind) ?? 0) + entry.count);
  }
  return [...merged].map(([kind, count]) => ({ kind, count }));
}

/**
 * What a surface says when a message went out with attachments: the whole count, and the kinds it was made of.
 *
 * The count is at least one — a message with a summary sent something — and when the kinds collapse to one the sentence
 * names it; otherwise the breakdown follows the total so a reader sees both how many and what.
 */
export function formatAttachmentSentSummary(count: number, kinds?: readonly AttachmentKindCount[] | null): string {
  const total = Math.max(1, Math.floor(count));
  const merged = mergeKindCounts(kinds);
  if (merged.length === 0) return `Sent ${kindPhrase("file", total)}`;
  const only = merged.length === 1 ? merged[0] : undefined;
  if (only !== undefined) return `Sent ${kindPhrase(only.kind, total)}`;
  const breakdown = merged.map((entry) => kindPhrase(entry.kind, entry.count)).join(", ");
  return `Sent ${kindPhrase("file", total)} · ${breakdown}`;
}
