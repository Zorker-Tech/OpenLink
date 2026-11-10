/**
 * Remembering rooms that were torn down.
 *
 * A tombstone names the room and the owner it belonged to, and what is remembered is written atomically; a reconcile
 * pass prunes the tombstones whose rooms came back, so a room that exists again is not treated as gone.
 */
import { mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";

export const SLATE_XUSER_ROOM_TOMBSTONE_FILE_NAME = "host-xuser-room-tombstones.json";

export interface XuserRoomTombstone {
  readonly roomId: string;
  readonly ownerAuthId?: string;
  readonly tornDownAtMs: number;
}

export interface XuserRoomTombstoneStore {
  list(): XuserRoomTombstone[];
  record(value: XuserRoomTombstone): void;
  clear(value: Pick<XuserRoomTombstone, "roomId" | "ownerAuthId">): void;
}

/** The separator between an owner and a room in a key: neither can hold one, so no two pairs share a key. */
const KEY_SEPARATOR = "\u0000";

/** What a tombstone is filed under: the owner it belonged to, and the room itself. */
export function tombstoneKey(tombstone: Pick<XuserRoomTombstone, "roomId" | "ownerAuthId">): string {
  return `${tombstone.ownerAuthId ?? ""}${KEY_SEPARATOR}${tombstone.roomId}`;
}

/** A stored tombstone read from whatever was written for it, or nothing when it does not say which room it is. */
function readTombstone(item: unknown): XuserRoomTombstone | null {
  if (typeof item !== "object" || item === null) return null;
  const entry = item as Record<string, unknown>;
  const roomId = entry["roomId"];
  if (typeof roomId !== "string" || roomId.length === 0) return null;
  const ownerAuthId = entry["ownerAuthId"];
  const tornDownAtMs = entry["tornDownAtMs"];
  return {
    roomId,
    ...(typeof ownerAuthId === "string" && ownerAuthId.length > 0 ? { ownerAuthId } : {}),
    tornDownAtMs: typeof tornDownAtMs === "number" && Number.isFinite(tornDownAtMs) ? tornDownAtMs : 0,
  };
}

/**
 * The tombstones a file holds, by their key.
 *
 * A file that is missing, is not JSON, or is JSON of another shape reads as no tombstones at all: a room that was torn
 * down and is not remembered is a room the next pass will read from the service rather than from here.
 */
export function parseTombstoneFile(raw: string | null): Map<string, XuserRoomTombstone> {
  const tombstones = new Map<string, XuserRoomTombstone>();
  if (raw == null) return tombstones;
  let stored: unknown;
  try {
    stored = JSON.parse(raw);
  } catch {
    return tombstones;
  }
  if (typeof stored !== "object" || stored === null) return tombstones;
  const listed = (stored as { tombstones?: unknown })["tombstones"];
  if (!Array.isArray(listed)) return tombstones;
  for (const item of listed) {
    const tombstone = readTombstone(item);
    if (tombstone !== null) tombstones.set(tombstoneKey(tombstone), tombstone);
  }
  return tombstones;
}

export class SlateXuserRoomTombstoneStore implements XuserRoomTombstoneStore {
  readonly filePath: string;

  /** What the file said when it was last read or written; nothing until then. */
  private cache: Map<string, XuserRoomTombstone> | null = null;

  constructor(rootDir: string) {
    this.filePath = join(rootDir, SLATE_XUSER_ROOM_TOMBSTONE_FILE_NAME);
  }

  list(): XuserRoomTombstone[] {
    return [...this.read().values()];
  }

  /** Remembers a room once: a tombstone that is already there keeps the moment it was first written. */
  record(value: XuserRoomTombstone): void {
    const tombstones = this.read();
    const key = tombstoneKey(value);
    if (tombstones.has(key)) return;
    tombstones.set(key, value);
    this.persist(tombstones);
  }

  /** Forgets a room, and writes only when it was remembered. */
  clear(value: Pick<XuserRoomTombstone, "roomId" | "ownerAuthId">): void {
    const tombstones = this.read();
    if (tombstones.delete(tombstoneKey(value))) this.persist(tombstones);
  }

  private read(): Map<string, XuserRoomTombstone> {
    if (this.cache != null) return this.cache;
    let raw: string | null;
    try {
      raw = readFileSync(this.filePath, "utf8");
    } catch {
      raw = null;
    }
    this.cache = parseTombstoneFile(raw);
    return this.cache;
  }

  /** Writes beside the file and renames over it, so a reader never sees half a list; a write that fails is not fatal. */
  private persist(tombstones: Map<string, XuserRoomTombstone>): void {
    this.cache = tombstones;
    const beside = `${this.filePath}.part`;
    try {
      mkdirSync(dirname(this.filePath), { recursive: true });
      writeFileSync(beside, JSON.stringify({ version: 1, tombstones: [...tombstones.values()] }));
      renameSync(beside, this.filePath);
    } catch {
      // A tombstone that could not be written is one the next pass will not find, which is the same as never having it.
    }
  }
}

/** The same store, kept in memory: for a caller that has no directory, or a test. */
export function createInMemoryXuserRoomTombstones(): XuserRoomTombstoneStore {
  const tombstones = new Map<string, XuserRoomTombstone>();
  return {
    list: () => [...tombstones.values()],
    record: (value) => {
      tombstones.set(tombstoneKey(value), value);
    },
    clear: (value) => {
      tombstones.delete(tombstoneKey(value));
    },
  };
}
