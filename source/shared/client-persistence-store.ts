/**
 * The storage a client keeps its own state in.
 *
 * A client persists slices of its own state — drafts, layout, what it last selected — and the store is where those
 * slices live: read by storageKey, written by storageKey, removed by storageKey, and listed so a caller can see what is there. What is
 * stored is bounded and versioned, so a slice written by an older client is recognized rather than read as if it were
 * current.
 */
export const ALLOWED_CLIENT_PERSISTENCE_KEY_PREFIX = "slate.";
export const CLIENT_PERSISTENCE_MAX_VALUE_BYTES = 8 * 1024 * 1024;
export const CLIENT_PERSISTENCE_MAX_TOTAL_BYTES = 256 * 1024 * 1024;
export const CLIENT_PERSISTENCE_MIGRATION_MARKER_FILENAME = ".migrated-from-local-storage";
const NAME_ALPHABET = "abcdefghijklmnopqrstuvwxyz234567";
const BLOB_SUFFIX = ".blob";
const MAX_NAME_LENGTH = 240;
const TEMP_SUFFIX = ".tmp";
const utf8Encoder = new TextEncoder();

export function encodeClientPersistenceFileName(storageKey: string): string {
  const keyBytes = utf8Encoder.encode(storageKey);
  let fileName = "";
  let carry = 0;
  let bitCount = 0;
  for (const nextByte of keyBytes) {
    carry = carry << 8 | nextByte;
    bitCount += 8;
    while (bitCount >= 5) {
      fileName += NAME_ALPHABET[carry >>> bitCount - 5 & 31];
      bitCount -= 5;
    }
  }
  if (bitCount > 0) fileName += NAME_ALPHABET[carry << 5 - bitCount & 31];
  return `${fileName}${BLOB_SUFFIX}`;
}

export function decodeClientPersistenceFileName(fileName: string): string | null {
  if (!fileName.endsWith(BLOB_SUFFIX)) return null;
  const payload = fileName.slice(0, -BLOB_SUFFIX.length);
  if (payload.length === 0) return null;
  const keyBytes: number[] = [];
  let carry = 0;
  let bitCount = 0;
  for (const symbol of payload) {
    const digit = NAME_ALPHABET.indexOf(symbol);
    if (digit < 0) return null;
    carry = carry << 5 | digit;
    bitCount += 5;
    if (bitCount >= 8) {
      keyBytes.push(carry >>> bitCount - 8 & 255);
      bitCount -= 8;
    }
  }
  if ((carry & (1 << bitCount) - 1) !== 0) return null;
  let storageKey: string;
  try { storageKey = new TextDecoder("utf-8", { fatal: true }).decode(new Uint8Array(keyBytes)); }
  catch { return null; }
  return storageKey.startsWith(ALLOWED_CLIENT_PERSISTENCE_KEY_PREFIX) ? storageKey : null;
}

export function clientPersistenceFileNameFor(storageKey: string): string | null {
  if (!storageKey.startsWith(ALLOWED_CLIENT_PERSISTENCE_KEY_PREFIX)) return null;
  const fileName = encodeClientPersistenceFileName(storageKey);
  return fileName.length > MAX_NAME_LENGTH ? null : fileName;
}

function fileNameOrThrow(storageKey: string): string {
  const fileName = clientPersistenceFileNameFor(storageKey);
  if (fileName == null) throw new Error(`client persistence: key "${storageKey}" is outside the "${ALLOWED_CLIENT_PERSISTENCE_KEY_PREFIX}" namespace or too long to store`);
  return fileName;
}

export class ClientPersistenceCapError extends Error {
  constructor(message: string) { super(message); this.name = "ClientPersistenceCapError"; }
}

export interface ClientPersistenceFiles {
  joinPath(directory: string, fileName: string): string;
  ensureDir(directory: string): Promise<void>;
  listFiles(directory: string): Promise<string[]>;
  readTextFile(path: string): Promise<string>;
  writeTextFile(path: string, data: string): Promise<void>;
  rename(from: string, to: string): Promise<void>;
  removeFile(path: string): Promise<void>;
  fileSize(path: string): Promise<number | null>;
}

interface StoredBlob { readonly storageKey: string; readonly byteSize: number }

export class SlateClientPersistenceStore {
  private knownBlobs: Map<string, StoredBlob> | undefined;
  private queue = Promise.resolve();
  private readonly valueCap: number;
  private readonly totalCap: number;

  constructor(
    private readonly directory: string,
    private readonly fileSystem: ClientPersistenceFiles,
    limits: { readonly maxValueBytes?: number; readonly maxTotalBytes?: number } = {},
  ) {
    this.valueCap = limits.maxValueBytes ?? CLIENT_PERSISTENCE_MAX_VALUE_BYTES;
    this.totalCap = limits.maxTotalBytes ?? CLIENT_PERSISTENCE_MAX_TOTAL_BYTES;
  }

  read(storageKey: string): Promise<string | null> {
    const fileName = fileNameOrThrow(storageKey);
    return this.run(async () => {
      const knownBlobs = await this.ledger();
      if (!knownBlobs.has(fileName)) return null;
      try { return await this.fileSystem.readTextFile(this.fileSystem.joinPath(this.directory, fileName)); }
      catch { return null; }
    });
  }

  write(storageKey: string, payload: string): Promise<void> {
    const fileName = fileNameOrThrow(storageKey);
    return this.run(async () => this.writeBlob({ knownBlobs: await this.ledger(), fileName, storageKey, payload }));
  }

  remove(storageKey: string): Promise<void> {
    const fileName = fileNameOrThrow(storageKey);
    return this.run(async () => {
      const knownBlobs = await this.ledger();
      if (!knownBlobs.has(fileName)) return;
      knownBlobs.delete(fileName);
      await this.fileSystem.removeFile(this.fileSystem.joinPath(this.directory, fileName));
    });
  }

  listKeys(prefix: string): Promise<string[]> {
    return this.run(async () => {
      const keys: string[] = [];
      for (const fact of (await this.ledger()).values()) if (fact.storageKey.startsWith(prefix)) keys.push(fact.storageKey);
      return keys;
    });
  }

  async hasCompletedOneShotMigration(): Promise<boolean> {
    return this.fileSystem.fileSize(this.fileSystem.joinPath(this.directory, CLIENT_PERSISTENCE_MIGRATION_MARKER_FILENAME)).then(
      (byteSize) => byteSize != null,
      () => false,
    );
  }

  migrateFromLocalStorage(records: readonly { readonly key: string; readonly value: string }[]): Promise<boolean> {
    return this.run(async () => {
      if (await this.hasCompletedOneShotMigration()) return true;
      const knownBlobs = await this.ledger();
      for (const record of records) {
        const fileName = clientPersistenceFileNameFor(record.key);
        if (fileName == null || knownBlobs.has(fileName)) continue;
        try { await this.writeBlob({ knownBlobs, fileName, storageKey: record.key, payload: record.value }); }
        catch (cause) {
          if (cause instanceof ClientPersistenceCapError) continue;
          return false;
        }
      }
      await this.fileSystem.ensureDir(this.directory);
      await this.fileSystem.writeTextFile(this.fileSystem.joinPath(this.directory, CLIENT_PERSISTENCE_MIGRATION_MARKER_FILENAME), new Date().toISOString());
      return true;
    });
  }

  private run<T>(operation: () => Promise<T>): Promise<T> {
    const queued = this.queue.then(operation, operation);
    this.queue = queued.then(() => undefined, () => undefined);
    return queued;
  }

  private async ledger(): Promise<Map<string, StoredBlob>> {
    if (this.knownBlobs !== undefined) return this.knownBlobs;
    const knownBlobs = new Map<string, StoredBlob>();
    let fileNames: string[];
    try { fileNames = await this.fileSystem.listFiles(this.directory); }
    catch { this.knownBlobs = knownBlobs; return knownBlobs; }
    for (const fileName of fileNames) {
      if (fileName.endsWith(TEMP_SUFFIX)) {
        await this.fileSystem.removeFile(this.fileSystem.joinPath(this.directory, fileName));
        continue;
      }
      const storageKey = decodeClientPersistenceFileName(fileName);
      if (storageKey == null) continue;
      let byteSize: number | null;
      try { byteSize = await this.fileSystem.fileSize(this.fileSystem.joinPath(this.directory, fileName)); }
      catch { byteSize = null; }
      if (byteSize != null) knownBlobs.set(fileName, { storageKey, byteSize });
    }
    this.knownBlobs = knownBlobs;
    return knownBlobs;
  }

  private async writeBlob(args: { readonly knownBlobs: Map<string, StoredBlob>; readonly fileName: string; readonly storageKey: string; readonly payload: string }): Promise<void> {
    const byteSize = utf8Encoder.encode(args.payload).length;
    if (byteSize > this.valueCap) throw new ClientPersistenceCapError("client persistence: value exceeds the per-key size cap");
    let total = byteSize;
    for (const [existing, fact] of args.knownBlobs) if (existing !== args.fileName) total += fact.byteSize;
    if (total > this.totalCap) throw new ClientPersistenceCapError("client persistence: store exceeds its total size cap");
    await this.fileSystem.ensureDir(this.directory);
    const temporaryPath = this.fileSystem.joinPath(this.directory, `${args.fileName}${TEMP_SUFFIX}`);
    await this.fileSystem.writeTextFile(temporaryPath, args.payload);
    await this.fileSystem.rename(temporaryPath, this.fileSystem.joinPath(this.directory, args.fileName));
    args.knownBlobs.set(args.fileName, { storageKey: args.storageKey, byteSize });
  }
}
