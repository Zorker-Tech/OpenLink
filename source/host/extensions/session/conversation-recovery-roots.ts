import { fromHex, toHex } from "../../../packages/agent-kv/serde.ts";
import type { SlateConversationCheckpointV2 } from "../../../packages/agent/conversation-checkpoint-state.ts";
import { decodeConversationStateStructure } from "../../../adapters/interop/local-conversation-state.ts";
import { MAX_ROOT_BLOB_BYTES, type ConversationStructureRefs, type RootScore } from "./conversation-recovery-contracts.ts";

type BlobReader = {
  getBlob(ctx: unknown, id: Uint8Array): Promise<Uint8Array | null>;
};

interface RootDatabase {
  prepare(sql: string): { iterate(): Iterable<unknown> };
}

/** Verify that all references in a snapshot still resolve to bounded blobs. */
export async function conversationStructureFullyResolves(
  ctx: unknown,
  structure: ConversationStructureRefs | SlateConversationCheckpointV2,
  blobStore: BlobReader,
): Promise<boolean> {
  const turns = "turnBlobIds" in structure ? structure.turnBlobIds.map(fromHex) : structure.turns;
  const todos = "todoBlobIds" in structure ? structure.todoBlobIds.map(fromHex) : structure.todos;
  const summary = "turnBlobIds" in structure
    ? structure.summaryBlobId === undefined ? undefined : fromHex(structure.summaryBlobId)
    : structure.summary;
  if (turns.length === 0) return false;

  const requiredIds = [...turns, ...todos];
  for (const id of requiredIds) {
    if (!await hasUsableBlob(ctx, id, blobStore)) return false;
  }
  if (summary?.length && !await hasUsableBlob(ctx, summary, blobStore)) return false;
  return true;
}

async function hasUsableBlob(ctx: unknown, id: Uint8Array, blobStore: BlobReader): Promise<boolean> {
  const blob = await blobStore.getBlob(ctx, id);
  return blob != null && blob.byteLength <= MAX_ROOT_BLOB_BYTES;
}

/** Score a serialized root only when it is small, decodable, nonempty and references present turn blobs. */
export function scoreRootCandidate(data: Uint8Array, presentIds: ReadonlySet<string>): RootScore | null {
  if (data.byteLength > MAX_ROOT_BLOB_BYTES) return null;

  let snapshot;
  try {
    snapshot = decodeConversationStateStructure(data);
  } catch {
    return null;
  }
  if (snapshot.turns.length === 0 || !allTurnBlobsPresent(snapshot.turns, presentIds)) return null;

  return {
    turns: snapshot.turns.length,
    rootPrompts: snapshot.rootPromptMessagesJson.length,
    bytes: data.byteLength,
  };
}

function allTurnBlobsPresent(turns: readonly Uint8Array[], presentIds: ReadonlySet<string>): boolean {
  for (const turnId of turns) if (!presentIds.has(toHex(turnId))) return false;
  return true;
}

/** Prefer the root with the most turns, then prompts, then bytes of retained state. */
export function isBetterRoot(candidate: RootScore, best: RootScore | null): boolean {
  if (best == null) return true;
  if (candidate.turns !== best.turns) return candidate.turns > best.turns;
  if (candidate.rootPrompts !== best.rootPrompts) return candidate.rootPrompts > best.rootPrompts;
  return candidate.bytes > best.bytes;
}

/** Find the strongest root candidate in the blob database and convert its hex key back to bytes. */
export function findLatestRootBlobIdInDatabase(db: RootDatabase): Uint8Array | null {
  const presentIds = readPresentBlobIds(db);
  let selectedId: string | null = null;
  let selectedScore: RootScore | null = null;

  for (const raw of db.prepare("SELECT id, data FROM blobs").iterate()) {
    const row = recordOf(raw);
    if (typeof row?.id !== "string" || !(row.data instanceof Uint8Array)) continue;
    const score = scoreRootCandidate(row.data, presentIds);
    if (score != null && isBetterRoot(score, selectedScore)) {
      selectedId = row.id;
      selectedScore = score;
    }
  }

  return selectedId == null ? null : fromHex(selectedId);
}

function readPresentBlobIds(db: RootDatabase): Set<string> {
  const ids = new Set<string>();
  for (const raw of db.prepare("SELECT id FROM blobs").iterate()) {
    const row = recordOf(raw);
    if (typeof row?.id === "string") ids.add(row.id);
  }
  return ids;
}

function recordOf(value: unknown): Record<string, unknown> | null {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null;
}
