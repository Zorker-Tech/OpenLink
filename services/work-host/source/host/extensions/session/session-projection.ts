/**
 * What a session looks like from outside: when it was last touched, and what it is showing.
 *
 * A session's last activity is seeded from the transcript's own filesystem time when nothing has marked activity yet,
 * and its last row is projected from the last visible transcript entry — a text, a widget's question, a link, an
 * attachment batch, or the preview of a message.
 */

/** One row of a transcript, as a projection reads it: the fields a surface needs are looked up by name. */
type EntryRow = Record<string, unknown>;

/** How much of a message a preview shows. */
const PREVIEW_MAX_CHARS = 280;

/** The date a session was created and the transcript file time, as one "last touched" date. */
export function getUpdatedAtFromStats(record: { createdAt: number }, fileStat?: { mtimeMs: number }): number {
  return Math.max(Number(record.createdAt), Math.floor(Number(fileStat?.mtimeMs ?? 0)));
}

/** The later of when the session started and when it was last active. */
export function getSummaryUpdatedAt(record: { createdAt: number }, activity: { lastActivityAt: number }): number {
  return Math.max(Number(record.createdAt), activity.lastActivityAt);
}

/** The session database as the activity seed needs to see it. */
interface ActivityDatabase {
  getUnreadState(): { lastActivityAt: number };
  get(key: string): Uint8Array | number;
  markActivity(at: number): void;
}

/**
 * Seeds the last activity of a session from its transcript's file time, but only when nothing has marked activity yet
 * and there is a root blob to speak of; a session with nothing in it has no activity to project.
 */
export function seedActivityFromMtime(store: ActivityDatabase, subjectAgentId: string, fileStat?: { mtimeMs: number }): void {
  if (store.getUnreadState().lastActivityAt > 0) return;
  const rootBlob = store.get("latestRootBlobId");
  if (!(rootBlob instanceof Uint8Array) || rootBlob.length === 0) return;
  store.markActivity(getUpdatedAtFromStats({ createdAt: Number(store.get("createdAt")) }, fileStat));
  void subjectAgentId;
}

/** Whether a raw string is an https url. */
export function isHttpsUrl(value: string): boolean {
  try {
    return new URL(value).protocol === "https:";
  } catch {
    return false;
  }
}

/** An attachment message: a file the user attached, or a link. */
export interface AttachmentMessage {
  type: "attachment";
  url: string;
  file_name?: string | null;
}

/** An attachment message that is a link: an https url and no name the user gave the file. */
export function isLinkAttachmentMessage(attachment: { type: string; url: string; file_name?: string | null }): boolean {
  return attachment.type === "attachment" && isHttpsUrl(attachment.url) && !attachment.file_name;
}

/** The kinds an attachment can be, and the text that names each kind, in the order the kinds are tried. */
const ATTACHMENT_KIND_PATTERNS: ReadonlyArray<readonly [string, RegExp]> = [
  ["image", /\.(png|jpe?g|gif|webp|svg)(\?|$)/],
  ["video", /\.(mp4|mov|webm|mkv)(\?|$)/],
  ["audio", /\.(mp3|wav|m4a|ogg)(\?|$)/],
  ["document", /\.(pdf|docx?|xlsx?|pptx?|txt|md)(\?|$)/],
];

/** What kind of attachment the file name and the url or path together say it is. */
function classifyAttachment(attachment: { fileName?: unknown; urlOrPath?: unknown }): "image" | "video" | "audio" | "document" | "other" {
  const haystack = `${String(attachment.fileName ?? "")} ${String(attachment.urlOrPath ?? "")}`.toLowerCase();
  for (const [name, matcher] of ATTACHMENT_KIND_PATTERNS) {
    if (matcher.test(haystack)) return name as "image" | "video" | "audio" | "document";
  }
  return "other";
}

/** How many attachments there are of each kind. */
function countKinds(types: readonly string[]): Record<string, number> {
  const counts: Record<string, number> = {};
  for (const type of types) counts[type] = (counts[type] ?? 0) + 1;
  return counts;
}

/** Whether two entries belong to the same uploaded batch: a batch id is only comparable when the anchor has one. */
function sameBatch(left: unknown, right: unknown): boolean {
  return typeof right === "string" && right.length > 0 && left === right;
}

/** The kinds of the attachment batch that ends at `at`, oldest first. */
export function collectLastAttachmentBatchKinds(rows: readonly EntryRow[], at: number): string[] {
  const newest = rows[at];
  const collected: string[] = [];
  if (newest?.kind === "user-attachment") {
    for (let cursor = at; cursor >= 0; cursor -= 1) {
      const row = rows[cursor];
      if (row?.kind !== "user-attachment") break;
      if (cursor !== at && !sameBatch(row.batchId, newest.batchId)) break;
      collected.push(classifyAttachment({ fileName: row.file_name, urlOrPath: row.file_path }));
    }
  } else if (newest?.kind === "send-message" && typeof newest.message === "object" && newest.message != null && (newest.message as EntryRow).type === "attachment") {
    for (let cursor = at; cursor >= 0; cursor -= 1) {
      const row = rows[cursor];
      const payload = row?.message as EntryRow | undefined;
      if (row?.kind !== "send-message" || payload?.type !== "attachment") break;
      if (isLinkAttachmentMessage(payload as unknown as AttachmentMessage) || cursor !== at && !sameBatch(row.batchId, newest.batchId)) break;
      collected.push(classifyAttachment({ fileName: payload.file_name, urlOrPath: payload.url }));
    }
  }
  return collected.reverse();
}

/** The last entry a transcript shows for an attachment batch ending at `at`. */
export function buildAttachmentLastEntry(rows: readonly EntryRow[], at: number): EntryRow {
  const collected = collectLastAttachmentBatchKinds(rows, at);
  return { kind: "attachment", count: collected.length, kinds: countKinds(collected) };
}

/** The text a preview shows: one line, no markdown markers, at most the preview length. */
function previewText(value: unknown): string {
  return String(value ?? "").replace(/\s+/g, " ").replace(/[*_`#>]/g, "").trim().slice(0, PREVIEW_MAX_CHARS);
}

/** The preview of one message, by what the message is. */
export function lastMessagePreviewText(payload: EntryRow): string {
  if (payload.type === "text") return previewText(payload.content);
  if (payload.type === "attachment" && typeof payload.url === "string" && isLinkAttachmentMessage(payload as unknown as AttachmentMessage)) {
    return `Sent a link · ${payload.url}`;
  }
  if (payload.type === "attachment") return `Sent an attachment · ${classifyAttachment({ fileName: payload.file_name, urlOrPath: payload.url })}`;
  if (typeof payload.title === "string") return previewText(payload.title);
  if (typeof payload.label === "string") return previewText(payload.label);
  return previewText(payload.type);
}

/** The newest send-message in a transcript and its preview, or null when there is none. */
export function getLastMessageFromTranscript(rows: readonly EntryRow[]): { id: string; preview: string } | null {
  for (let cursor = rows.length - 1; cursor >= 0; cursor -= 1) {
    const row = rows[cursor];
    if (row?.kind !== "send-message" || typeof row.id !== "string" || row.message == null || typeof row.message !== "object") continue;
    return { id: row.id, preview: lastMessagePreviewText(row.message as EntryRow) };
  }
  return null;
}

/** The text a widget question is shown with: its prompt, and the answer when the user gave one. */
function widgetText(row: EntryRow, payload: EntryRow): string {
  const widget = payload.widget as EntryRow | undefined;
  const prompt = typeof widget?.prompt === "string" ? widget.prompt : "Question";
  return row.respondedValue == null ? prompt : `${prompt} — ${String(row.respondedValue)}`;
}

/** What one send-message entry shows as the conversation's last row. */
function sendMessageProjection(row: EntryRow, payload: EntryRow, shown: readonly EntryRow[], at: number): EntryRow {
  if (payload.type === "text") return { kind: "text", text: String(payload.content ?? "") };
  if (payload.type === "widget") return { kind: "text", text: widgetText(row, payload) };
  if (payload.type === "attachment" && typeof payload.url === "string" && isLinkAttachmentMessage(payload as unknown as AttachmentMessage)) {
    return { kind: "link", url: payload.url };
  }
  if (payload.type === "attachment") return buildAttachmentLastEntry(shown, at);
  return { kind: "text", text: lastMessagePreviewText(payload) };
}

/** The last row a transcript shows: the last visible entry that has something to say about the conversation. */
export function getLastEntryFromTranscript(rows: readonly EntryRow[]): EntryRow | null {
  const shown = rows.filter((row) => row.hidden !== true && row.branched !== true);
  for (let cursor = shown.length - 1; cursor >= 0; cursor -= 1) {
    const row = shown[cursor];
    if (row == null || row.peerAgentId != null) continue;
    if (row.kind === "send-message" && row.message && typeof row.message === "object") {
      return sendMessageProjection(row, row.message as EntryRow, shown, cursor);
    }
    if (row.kind === "message" && typeof row.content === "string" && row.content.length > 0) return { kind: "text", text: row.content };
    if (row.kind === "user-attachment") return buildAttachmentLastEntry(shown, cursor);
  }
  return null;
}
