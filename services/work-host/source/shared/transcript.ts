/**
 * Settling an approval that a surface is still showing.
 *
 * A transcript may hold an entry waiting for the user — an auto-review approval, or a local tool permission — and when
 * the answer arrives the entry is settled rather than left pending: only the entry that is actually pending and, when
 * the caller names one, the one whose request it is, is changed; anything else is left as it was.
 */
export const SLATE_AUTO_REVIEW_STALE = "auto-review/stale";
export const SLATE_AUTO_REVIEW_STALE_MESSAGE = "The Auto-review request is stale, expired, or not authorized.";

interface ApprovalEntry {
  readonly kind: string;
  readonly message?: {
    readonly type?: string;
    readonly approval?: { readonly requestId: string; readonly status: string; readonly [key: string]: unknown };
    readonly ask?: { readonly requestId: string; readonly status: string; readonly [key: string]: unknown };
    readonly [key: string]: unknown;
  };
  readonly id?: string;
  readonly replyTo?: string;
  readonly branched?: boolean;
  readonly fromAgent?: unknown;
  readonly toAgent?: { readonly kind?: string };
  readonly [key: string]: unknown;
}

/** The kinds of entry that can be part of a thread; anything else is never branched. */
const THREADED_KINDS: readonly string[] = ["message", "send-message", "user-attachment", "notice"];

/** Whether an entry is one of the kinds a thread is made of. */
function isThreadedKind(entry: ApprovalEntry): boolean {
  return THREADED_KINDS.includes(entry.kind);
}

/** The entry this one replies to, for the kinds that can reply at all. */
function getEntryReplyTo(entry: ApprovalEntry): string | undefined {
  return isThreadedKind(entry) ? entry.replyTo : undefined;
}

function isBranchedEntry(entry: ApprovalEntry): boolean {
  return isThreadedKind(entry) && entry.branched === true;
}

/** The entries by their own id, for the walks below; an entry with no id is in no thread. */
function indexById<T extends ApprovalEntry>(entries: readonly T[]): Map<string, T> {
  return new Map(entries.flatMap((entry) => (entry.id === undefined ? [] : [[entry.id, entry] as const])));
}

/**
 * The entry a branch hangs from, walking the replies up while they are themselves branched.
 *
 * A reply whose parent is not branched hangs off that parent; a reply whose parent is not held here hangs off nothing,
 * and so does a cycle, which would otherwise walk forever.
 */
function resolveBranchRoot(entry: ApprovalEntry, byId: ReadonlyMap<string, ApprovalEntry>): string | null {
  const walked = new Set([entry.id]);
  for (let current = entry; ; ) {
    const parentId = getEntryReplyTo(current);
    if (parentId == null) return null;
    const parent = byId.get(parentId);
    if (parent == null) return null;
    if (!isBranchedEntry(parent)) return parentId;
    if (walked.has(parentId)) return null;
    walked.add(parentId);
    current = parent;
  }
}

/** The two fields an entry may be waiting on, each with the message type that carries it. */
const PENDING_FIELDS = {
  approval: "auto-review-approval",
  ask: "local-tool-permission",
} as const;

type PendingField = keyof typeof PENDING_FIELDS;

/**
 * The entry with the one field it was waiting on settled, or nothing when it was not waiting on that field.
 *
 * Only an entry that is still pending is changed, and — when the caller names a request — only the one whose request it
 * is; everything else is handed back as nothing, so a caller can tell "settled" from "was not pending".
 */
function settlePending<T extends ApprovalEntry>(entry: T, field: PendingField, status: string, requestId?: string): T | null {
  const waiting = entry.message?.[field] as { readonly requestId: string; readonly status: string } | undefined;
  if (entry.kind !== "send-message" || entry.message?.type !== PENDING_FIELDS[field]) return null;
  if (waiting?.status !== "pending" || (requestId != null && waiting.requestId !== requestId)) return null;
  return { ...entry, message: { ...entry.message, [field]: { ...waiting, status } } } as T;
}

/** Settles an auto-review approval that is still pending, and leaves anything else exactly as it was. */
export function settledAutoReviewEntry<T extends ApprovalEntry>(entry: T, status: string, requestId?: string): T | null {
  return settlePending(entry, "approval", status, requestId);
}

/** Settles a local tool permission that is still pending, and leaves anything else exactly as it was. */
export function settledToolPermissionEntry<T extends ApprovalEntry>(entry: T, status: string, requestId?: string): T | null {
  return settlePending(entry, "ask", status, requestId);
}

export const SLATE_REACTION_SELF = "me";
export const SLATE_REACTION_AGENT = "agent";

/**
 * The entries that belong to the main transcript.
 *
 * A branched entry that hangs from an entry the transcript holds is part of a thread and is left out; when nothing is
 * threaded at all the list is handed back as it came, which is the common case and costs no filtering.
 */
export function mainTranscriptOf<T extends ApprovalEntry>(entries: readonly T[]): readonly T[] {
  const byId = indexById(entries);
  const isThreadMessage = (entry: T) => isBranchedEntry(entry) && resolveBranchRoot(entry, byId) != null;
  if (!entries.some(isThreadMessage)) return entries;
  return entries.filter((entry) => !isThreadMessage(entry));
}

/** Every entry in the thread this root hangs, the root included, in the order the transcript holds them. */
export function threadOf<T extends ApprovalEntry>(entries: readonly T[], rootId: string): readonly T[] {
  const byId = indexById(entries);
  if (!byId.has(rootId)) return [];
  const children = new Map<string, string[]>();
  for (const candidate of entries) {
    const parentId = getEntryReplyTo(candidate);
    if (parentId == null || candidate.id == null) continue;
    const bucket = children.get(parentId);
    if (bucket == null) children.set(parentId, [candidate.id]);
    else bucket.push(candidate.id);
  }
  const inThread = new Set([rootId]);
  const pending = [rootId];
  while (pending.length > 0) {
    const nextId = pending.shift();
    if (nextId == null) continue;
    for (const childId of children.get(nextId) ?? []) {
      if (inThread.has(childId)) continue;
      const child = byId.get(childId);
      if (child == null || !isBranchedEntry(child)) continue;
      inThread.add(childId);
      pending.push(childId);
    }
  }
  return entries.filter((candidate) => candidate.id !== undefined && inThread.has(candidate.id));
}

/** Whether an entry is a message between agents, which the user is not shown as their own conversation. */
export function isPeerMessage(entry: ApprovalEntry | null | undefined): boolean {
  return entry != null && entry.kind === "message" && (entry.fromAgent != null || entry.toAgent != null);
}

export function isOutboundPeerMessage(entry: ApprovalEntry | null | undefined): boolean {
  return entry != null && entry.kind === "message" && entry.toAgent != null;
}

/** An outbound message to something that is not another agent is not a conversation with a peer, and is hidden. */
export function isHiddenOutboundPeerMessage(entry: ApprovalEntry | null | undefined): boolean {
  return isOutboundPeerMessage(entry) && entry?.toAgent?.kind !== "agent";
}

/** Whether an entry counts as the user having been active, which a message between agents does not. */
export function raisesUserActivity(entry: ApprovalEntry): boolean {
  return !isPeerMessage(entry);
}
