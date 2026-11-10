/**
 * A departure that could not be delivered yet.
 *
 * Leaving a room or removing an agent is recorded with what identifies it — the owner when there is one, and either
 * the room or the agent — so the same departure is recognized when it is retried or cleared, and the file is written
 * atomically.
 */
import { mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";

/** The name of the file this store keeps beside the rest of the host's state. */
export const SLATE_XUSER_PENDING_DEPARTURE_FILE_NAME = "host-xuser-pending-departures.json";

/** The version the written file announces, so a later shape can be told from this one. */
const STORE_FILE_VERSION = 2;

export type XuserDeparture = { readonly kind: "leave-room"; readonly ownerAuthId?: string; readonly roomId: string; readonly agentId: string } | { readonly kind: "remove-agent"; readonly ownerAuthId?: string; readonly agentId: string };

export interface XuserPendingDepartureStore { list(): XuserDeparture[]; record(value: XuserDeparture): void; clear(value: XuserDeparture): void }

/** What identifies a departure: its kind, its owner (empty when there is none) and the room or agent it is about. */
export function departureKey(value: XuserDeparture): string {
  const owner = value.ownerAuthId ?? "";
  return value.kind === "leave-room" ? `leave-room\0${owner}\0${value.roomId}` : `remove-agent\0${owner}\0${value.agentId}`;
}

/** A non-empty string, or undefined when the value is anything else — the only shape a stored entry accepts. */
function nonEmptyString(value: unknown): string | undefined {
  return typeof value === "string" && value !== "" ? value : undefined;
}

/** One entry of the stored file as a departure, or null when it does not name one. */
function departureFromEntry(item: unknown): XuserDeparture | null {
  if (typeof item !== "object" || item === null) return null;
  const entry = item as Record<string, unknown>;
  const agentId = nonEmptyString(entry.agentId);
  if (agentId === undefined) return null;
  const ownerAuthId = nonEmptyString(entry.ownerAuthId);
  const owner = ownerAuthId === undefined ? {} : { ownerAuthId };
  if (entry.kind === "leave-room") {
    const roomId = nonEmptyString(entry.roomId);
    return roomId === undefined ? null : { kind: "leave-room", ...owner, roomId, agentId };
  }
  if (entry.kind === "remove-agent") return { kind: "remove-agent", ...owner, agentId };
  return null;
}

/** The entries a stored file holds, or none when it is missing, unreadable or not the shape this build writes. */
function pendingEntries(raw: string | null): unknown[] {
  if (raw == null) return [];
  let stored: unknown;
  try { stored = JSON.parse(raw); } catch { return []; }
  if (typeof stored !== "object" || stored === null) return [];
  const pending = (stored as { pending?: unknown }).pending;
  return Array.isArray(pending) ? pending : [];
}

/** The departures a stored file holds, keyed by what identifies each one. */
export function parseDepartureFile(raw: string | null): Map<string, XuserDeparture> {
  const departures = new Map<string, XuserDeparture>();
  for (const item of pendingEntries(raw)) {
    const departure = departureFromEntry(item);
    if (departure !== null) departures.set(departureKey(departure), departure);
  }
  return departures;
}

export class SlateXuserPendingDepartureStore implements XuserPendingDepartureStore {
  readonly filePath: string;
  private cache: Map<string, XuserDeparture> | null = null;

  constructor(rootDir: string) {
    this.filePath = join(rootDir, SLATE_XUSER_PENDING_DEPARTURE_FILE_NAME);
  }

  list(): XuserDeparture[] {
    return [...this.read().values()];
  }

  record(value: XuserDeparture): void {
    const departures = this.read();
    const key = departureKey(value);
    if (departures.has(key)) return;
    departures.set(key, value);
    this.persist(departures);
  }

  clear(value: XuserDeparture): void {
    const departures = this.read();
    if (!departures.delete(departureKey(value))) return;
    this.persist(departures);
  }

  /** The departures as last read or written; the file is read once per store instance. */
  private read(): Map<string, XuserDeparture> {
    if (this.cache !== null) return this.cache;
    let raw: string | null = null;
    try { raw = readFileSync(this.filePath, "utf8"); } catch { raw = null; }
    this.cache = parseDepartureFile(raw);
    return this.cache;
  }

  /** Write the whole list beside the old file and rename it into place, so a reader never sees half a file. */
  private persist(departures: Map<string, XuserDeparture>): void {
    this.cache = departures;
    const pendingPath = `${this.filePath}.part`;
    try {
      mkdirSync(dirname(this.filePath), { recursive: true });
      writeFileSync(pendingPath, JSON.stringify({ version: STORE_FILE_VERSION, pending: [...departures.values()] }));
      renameSync(pendingPath, this.filePath);
    } catch {
      // A write that fails leaves the old file alone; the next departure tries again.
    }
  }
}

/** The same contract over an in-memory map, for the host's tests and for a host with no state directory. */
export function createInMemoryXuserPendingDepartures(): XuserPendingDepartureStore {
  const departures = new Map<string, XuserDeparture>();
  return {
    list: () => [...departures.values()],
    record: (value) => { departures.set(departureKey(value), value); },
    clear: (value) => { departures.delete(departureKey(value)); },
  };
}
