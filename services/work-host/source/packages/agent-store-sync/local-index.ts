/**
 * The store's local index: the file that says what has been pulled and pushed, what is tombstoned and what is still
 * waiting to be deleted.
 *
 * The index is one SQLite file kept inside the store, opened through the secure path helpers so a symlinked or
 * world-readable database is refused rather than trusted. Its schema carries a version and is migrated forward in
 * place; a version this build does not know is refused instead of being guessed at. Every write goes through the same
 * private-file-mode hardening, and file identities are recorded against the deletion marker so a stale tombstones sweep
 * can tell this store's directory from a different one.
 */
import * as fs from "node:fs";
import * as path from "node:path";

import { assertNoSymlinkInPath, ensureSecureDirectoryChain } from "./paths.ts";
import { openSecureSqlitePath, type SecureSqlitePath } from "./secure-open.ts";

/** The schema this build writes, and the mode every file of the index is kept at. */
const CURRENT_SCHEMA_VERSION = 3;
const PRIVATE_FILE_MODE = 0o600;

/** Meta keys the synchronizer and the tombstones sweep agree on. */
export const META_DELETION_ARMED = "deletion_armed";
export const META_FILES_ROOT_DEV = "files_root_dev";
export const META_FILES_ROOT_INO = "files_root_ino";

/** Why a local index could not be opened. */
export type LocalIndexErrorCode = "unsupported_schema_version";

/** A refused local index, carrying the reason it was refused. */
export class LocalIndexError extends Error {
  readonly code: LocalIndexErrorCode;

  constructor(code: LocalIndexErrorCode, message: string) {
    super(message);
    this.code = code;
    this.name = "LocalIndexError";
  }
}

type FileDirection = "pulled" | "pushed";
type FileState = "live" | "tombstoned";

/** One file as the index remembers it: what was synced, when, and in which direction. */
interface FileEntry {
  readonly relPath: string;
  readonly lastSyncedSha: string;
  readonly lastSeenEtag?: string;
  readonly size: number;
  readonly lastSyncedMs: number;
  readonly direction: FileDirection;
  readonly state?: FileState;
  readonly tombstoneEtag?: string;
  readonly deletedAtMs?: number;
}

/** One deletion the store owes the counterpart when it next talks to it. */
interface PendingDeleteEntry {
  readonly relPath: string;
  readonly baseEtag: string;
  readonly requestedAtMs: number;
  readonly mutationId?: string;
}

/** The directory identity recorded when deletion was armed. */
interface FileIdentity {
  readonly dev: number;
  readonly ino: number;
}

/** The row shape the SQLite driver answers with. */
interface SqliteRow {
  readonly [key: string]: unknown;
}

interface SqliteStatement {
  get(...params: unknown[]): SqliteRow | undefined;
  all(...params: unknown[]): SqliteRow[];
  run(...params: unknown[]): { readonly changes: number };
}

interface SqliteDatabase {
  close(): void;
  exec(sql: string): void;
  pragma(sql: string): unknown;
  prepare(sql: string): SqliteStatement;
  transaction<T>(callback: () => T): () => T;
}

/** The driver a caller opens the index with, injected so tests can watch the database. */
interface LocalIndexOptions {
  readonly sqlite: new (path: string) => SqliteDatabase;
}

/** The columns a file row is read from and written to. */
const FILE_COLUMNS = "rel_path, last_synced_sha, last_seen_etag, size, last_synced_ms, direction, state, tombstone_etag, deleted_at_ms";
/** The columns a pending deletion row is read from and written to. */
const PENDING_DELETE_COLUMNS = "rel_path, base_etag, requested_at_ms, mutation_id";

const SELECT_FILE_BY_PATH = `SELECT ${FILE_COLUMNS} FROM files WHERE rel_path = ?`;
const SELECT_FILES_ORDERED = `SELECT ${FILE_COLUMNS} FROM files ORDER BY rel_path ASC`;
const SELECT_PENDING_DELETES_ORDERED = `SELECT ${PENDING_DELETE_COLUMNS} FROM pending_deletes ORDER BY rel_path ASC`;
const UPSERT_FILE = `
        INSERT INTO files (
          rel_path,
          last_synced_sha,
          last_seen_etag,
          size,
          last_synced_ms,
          direction,
          state,
          tombstone_etag,
          deleted_at_ms
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT(rel_path) DO UPDATE SET
          last_synced_sha = excluded.last_synced_sha,
          last_seen_etag = excluded.last_seen_etag,
          size = excluded.size,
          last_synced_ms = excluded.last_synced_ms,
          direction = excluded.direction,
          state = excluded.state,
          tombstone_etag = excluded.tombstone_etag,
          deleted_at_ms = excluded.deleted_at_ms
      `;
const UPSERT_PENDING_DELETE = `
        INSERT INTO pending_deletes (
          rel_path,
          base_etag,
          requested_at_ms,
          mutation_id
        ) VALUES (?, ?, ?, ?)
        ON CONFLICT(rel_path) DO UPDATE SET
          base_etag = excluded.base_etag,
          requested_at_ms = excluded.requested_at_ms,
          mutation_id = excluded.mutation_id
      `;
const UPSERT_META = `
          INSERT INTO meta (key, value)
          VALUES (?, ?)
          ON CONFLICT(key) DO UPDATE SET value = excluded.value
        `;
const UPSERT_META_SIMPLE = `
        INSERT INTO meta (key, value)
        VALUES (?, ?)
        ON CONFLICT(key) DO UPDATE SET value = excluded.value
      `;
const CREATE_META_TABLE = `
      CREATE TABLE IF NOT EXISTS meta (
        key TEXT PRIMARY KEY,
        value TEXT NOT NULL
      );
    `;
const CREATE_FILES_TABLE = `
      CREATE TABLE IF NOT EXISTS files (
        rel_path TEXT PRIMARY KEY,
        last_synced_sha TEXT NOT NULL,
        last_seen_etag TEXT,
        size INTEGER NOT NULL,
        last_synced_ms INTEGER NOT NULL,
        direction TEXT NOT NULL CHECK(direction IN ('pulled', 'pushed')),
        state TEXT NOT NULL DEFAULT 'live' CHECK(state IN ('live', 'tombstoned')),
        tombstone_etag TEXT,
        deleted_at_ms INTEGER
      );
    `;
const CREATE_PENDING_DELETES_TABLE = `
      CREATE TABLE IF NOT EXISTS pending_deletes (
        rel_path TEXT PRIMARY KEY,
        base_etag TEXT NOT NULL,
        requested_at_ms INTEGER NOT NULL,
        mutation_id TEXT
      );
    `;

/** The columns the file schema had before each migration, by name. */
const V1_COLUMN_LAST_SEEN_SHA = "last_seen_sha";
const V2_COLUMN_LAST_SEEN_ETAG = "last_seen_etag";
const V3_COLUMNS = {
  state: "state TEXT NOT NULL DEFAULT 'live' CHECK(state IN ('live', 'tombstoned'))",
  tombstoneEtag: "tombstone_etag TEXT",
  deletedAtMs: "deleted_at_ms INTEGER",
} as const;

/**
 * The local index of one store.
 *
 * Opening the same path twice hands back the same instance until it is closed, so two parts of the process cannot
 * write through two connections to one database.
 */
export class LocalAgentStoreIndex {
  private static readonly openByPath = new Map<string, LocalAgentStoreIndex>();
  private readonly resolvedIndexPath: string;
  private readonly database: SqliteDatabase;
  private securePath: SecureSqlitePath | undefined;
  private isClosed = false;

  /** Open the index at a path, migrating it to the current schema, or hand back the one already open. */
  static open(indexPath: string, options: LocalIndexOptions): LocalAgentStoreIndex {
    const resolvedPath = path.resolve(indexPath);
    const alreadyOpen = LocalAgentStoreIndex.openByPath.get(resolvedPath);
    if (alreadyOpen !== undefined && !alreadyOpen.isClosed) return alreadyOpen;
    assertNoSymlinkInPath(resolvedPath);
    ensureSecureDirectoryChain(path.dirname(resolvedPath));
    assertNoSymlinkInPath(resolvedPath);
    const securePath = openSecureSqlitePath(resolvedPath, PRIVATE_FILE_MODE);
    let database: SqliteDatabase | undefined;
    try {
      database = new options.sqlite(securePath.sqlitePath);
      securePath.verifyOpenedInode();
      hardenIndexFileModes(resolvedPath);
      const index = new LocalAgentStoreIndex(resolvedPath, database);
      index.securePath = securePath;
      index.migrate();
      index.restrictFileModes();
      LocalAgentStoreIndex.openByPath.set(resolvedPath, index);
      return index;
    } catch (error) {
      database?.close();
      securePath.close();
      throw error;
    }
  }

  private constructor(indexPath: string, database: SqliteDatabase) {
    this.resolvedIndexPath = indexPath;
    this.database = database;
  }

  /** Close the connection and forget the handle; disposing twice is harmless. */
  close(): void {
    if (this.isClosed) return;
    this.database.close();
    this.securePath?.close();
    this.securePath = undefined;
    this.isClosed = true;
    LocalAgentStoreIndex.openByPath.delete(this.resolvedIndexPath);
  }

  getFile(relPath: string): FileEntry | undefined {
    const row = this.database.prepare(SELECT_FILE_BY_PATH).get(relPath);
    return row === undefined ? undefined : fileEntryFromRow(row);
  }

  listFiles(): FileEntry[] {
    return this.database.prepare(SELECT_FILES_ORDERED).all().map(fileEntryFromRow);
  }

  /** Write one file's sync state, keeping a tombstone's etag and deletion time only while it is a tombstone. */
  upsertFile(entry: FileEntry): void {
    const state = entry.state ?? "live";
    const tombstoned = state === "tombstoned";
    this.database.prepare(UPSERT_FILE).run(
      entry.relPath,
      entry.lastSyncedSha,
      entry.lastSeenEtag ?? null,
      entry.size,
      entry.lastSyncedMs,
      entry.direction,
      state,
      tombstoned ? entry.tombstoneEtag ?? null : null,
      tombstoned ? entry.deletedAtMs ?? null : null,
    );
    this.restrictFileModes();
  }

  listPendingDeletes(): PendingDeleteEntry[] {
    return this.database.prepare(SELECT_PENDING_DELETES_ORDERED).all().map(pendingDeleteFromRow);
  }

  hasPendingDelete(relPath: string): boolean {
    return this.database.prepare("SELECT rel_path FROM pending_deletes WHERE rel_path = ?").get(relPath) !== undefined;
  }

  upsertPendingDelete(entry: PendingDeleteEntry): void {
    this.database.prepare(UPSERT_PENDING_DELETE).run(entry.relPath, entry.baseEtag, entry.requestedAtMs, entry.mutationId ?? null);
    this.restrictFileModes();
  }

  removePendingDelete(relPath: string): boolean {
    return this.database.prepare("DELETE FROM pending_deletes WHERE rel_path = ?").run(relPath).changes > 0;
  }

  clearPendingDeletes(): number {
    return this.database.prepare("DELETE FROM pending_deletes").run().changes;
  }

  /** Disarm the deletion marker, forget the directory identity and clear what was queued, in one transaction. */
  disarmDeletionAndClearPending(): number {
    const disarm = this.database.transaction(() => {
      this.database.prepare(UPSERT_META).run(META_DELETION_ARMED, "0");
      this.database.prepare("DELETE FROM meta WHERE key = ?").run(META_FILES_ROOT_DEV);
      this.database.prepare("DELETE FROM meta WHERE key = ?").run(META_FILES_ROOT_INO);
      return this.database.prepare("DELETE FROM pending_deletes").run().changes;
    });
    const cleared = disarm();
    this.restrictFileModes();
    return cleared;
  }

  /** Arm the deletion marker with the directory identity it belongs to, in one transaction. */
  armDeletionWithIdentity(identity: FileIdentity): void {
    const arm = this.database.transaction(() => {
      const upsert = this.database.prepare(UPSERT_META);
      upsert.run(META_DELETION_ARMED, "1");
      upsert.run(META_FILES_ROOT_DEV, String(identity.dev));
      upsert.run(META_FILES_ROOT_INO, String(identity.ino));
    });
    arm();
    this.restrictFileModes();
  }

  deleteFile(relPath: string): boolean {
    const removed = this.database.prepare("DELETE FROM files WHERE rel_path = ?").run(relPath).changes > 0;
    if (removed) this.restrictFileModes();
    return removed;
  }

  getMeta(key: string): string | undefined {
    const row = this.database.prepare("SELECT value FROM meta WHERE key = ?").get(key);
    return row === null || row === undefined ? undefined : stringValue(row.value);
  }

  setMeta(entry: { readonly key: string; readonly value: string }): void {
    this.database.prepare(UPSERT_META_SIMPLE).run(entry.key, entry.value);
    this.restrictFileModes();
  }

  /** Bring the schema to this build's version, migrating what is older and refusing what is newer. */
  private migrate(): void {
    this.database.pragma("journal_mode = WAL");
    this.database.pragma("synchronous = NORMAL");
    this.database.pragma("busy_timeout = 5000");
    this.database.exec(CREATE_META_TABLE);
    const version = this.getMeta("schema_version");
    if (version === undefined) {
      this.createCurrentSchema();
      return;
    }
    const parsedVersion = Number(version);
    if (!Number.isInteger(parsedVersion) || parsedVersion < 1 || parsedVersion > CURRENT_SCHEMA_VERSION) {
      throw new LocalIndexError("unsupported_schema_version", `Unsupported agent store index schema version: ${version}`);
    }
    this.createFilesTableIfNeeded();
    if (parsedVersion < 2) this.migrateV1ToV2();
    if (parsedVersion < 3) this.migrateV2ToV3();
  }

  private createCurrentSchema(): void {
    this.createFilesTableIfNeeded();
    this.createPendingDeletesTableIfNeeded();
    this.setMeta({ key: "schema_version", value: String(CURRENT_SCHEMA_VERSION) });
  }

  private createFilesTableIfNeeded(): void {
    this.database.exec(CREATE_FILES_TABLE);
  }

  private createPendingDeletesTableIfNeeded(): void {
    this.database.exec(CREATE_PENDING_DELETES_TABLE);
  }

  /** v1 called the synced sha and the etag differently; v2 added the etag of the last seen copy. */
  private migrateV1ToV2(): void {
    const columns = tableColumns(this.database, "files");
    if (columns.has(V1_COLUMN_LAST_SEEN_SHA)) this.database.exec("ALTER TABLE files RENAME COLUMN last_seen_sha TO last_synced_sha");
    if (!columns.has(V2_COLUMN_LAST_SEEN_ETAG)) this.database.exec("ALTER TABLE files ADD COLUMN last_seen_etag TEXT");
    this.setMeta({ key: "schema_version", value: "2" });
  }

  /** v3 added tombstones: the tombstoned state, the etag that was deleted and when. */
  private migrateV2ToV3(): void {
    const columns = tableColumns(this.database, "files");
    if (!columns.has("state")) this.database.exec(`ALTER TABLE files ADD COLUMN ${V3_COLUMNS.state}`);
    if (!columns.has("tombstone_etag")) this.database.exec("ALTER TABLE files ADD COLUMN tombstone_etag TEXT");
    if (!columns.has("deleted_at_ms")) this.database.exec("ALTER TABLE files ADD COLUMN deleted_at_ms INTEGER");
    this.createPendingDeletesTableIfNeeded();
    this.setMeta({ key: "schema_version", value: String(CURRENT_SCHEMA_VERSION) });
  }

  private restrictFileModes(): void {
    hardenIndexFileModes(this.resolvedIndexPath);
  }
}

/** One file row read as the entry the rest of the platform works with. */
function fileEntryFromRow(row: SqliteRow): FileEntry {
  return {
    relPath: stringValue(row.rel_path),
    lastSyncedSha: stringValue(row.last_synced_sha),
    ...(isPresent(row.last_seen_etag) ? { lastSeenEtag: stringValue(row.last_seen_etag) } : {}),
    size: numberValue(row.size),
    lastSyncedMs: numberValue(row.last_synced_ms),
    direction: directionValue(row.direction),
    state: stateValue(row.state),
    ...(isPresent(row.tombstone_etag) ? { tombstoneEtag: stringValue(row.tombstone_etag) } : {}),
    ...(isPresent(row.deleted_at_ms) ? { deletedAtMs: numberValue(row.deleted_at_ms) } : {}),
  };
}

/** One pending-deletion row read as the entry the synchronizer queues. */
function pendingDeleteFromRow(row: SqliteRow): PendingDeleteEntry {
  return {
    relPath: stringValue(row.rel_path),
    baseEtag: stringValue(row.base_etag),
    requestedAtMs: numberValue(row.requested_at_ms),
    ...(isPresent(row.mutation_id) ? { mutationId: stringValue(row.mutation_id) } : {}),
  };
}

/** Whether a column came back with a value rather than SQL NULL. */
function isPresent(value: unknown): boolean {
  return value !== null && value !== undefined;
}

/** The column names a table has, for a migration to decide what still needs adding. */
function tableColumns(database: SqliteDatabase, table: string): Set<string> {
  return new Set(database.prepare(`PRAGMA table_info(${table})`).all().map(row => stringValue(row.name)));
}

/** Keep every file of the index private, including the write-ahead log and its shared-memory file. */
function hardenIndexFileModes(indexPath: string): void {
  for (const filePath of [indexPath, `${indexPath}-wal`, `${indexPath}-shm`]) {
    if (fs.existsSync(filePath)) fs.chmodSync(filePath, PRIVATE_FILE_MODE);
  }
}

function stringValue(value: unknown): string {
  return value as string;
}

function numberValue(value: unknown): number {
  return value as number;
}

function directionValue(value: unknown): FileDirection {
  return value as FileDirection;
}

function stateValue(value: unknown): FileState {
  return value as FileState;
}
