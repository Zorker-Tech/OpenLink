/**
 * One writer at a time in a store.
 *
 * The lock is a file in the store's own directory holding who holds it and when. It is taken by creating that file
 * exclusively, refreshed while it is held, and released only by the holder that still owns it. A lock whose holder is
 * gone, or which has not been refreshed for long enough, is recognized as stale and taken over rather than waited on
 * forever; a lock held by another operating-system identity is never taken over and is reported as foreign.
 */
import { execFileSync } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { assertNoSymlinkInPath, ensureSecureDirectoryChain } from "./paths.ts";
import { writeLockFileExclusive } from "./secure-open.ts";

/** How often a held lock refreshes its modification time, and when an unrefreshed lock counts as stale. */
export const STORE_LOCK_MTIME_UPDATE_MS = 1_000;
export const STORE_LOCK_STALE_MS = 10 * 60 * 1_000;
const LOCKFILE_PRIVATE_MODE = 0o600;

/** Why a store lock could not be read, taken or trusted. */
export type StoreLockErrorCode = "missing_identity" | "invalid_lockfile" | "foreign_identity_lock";

/** A refused store lock, carrying the reason and the lockfile it is about. */
export class StoreLockError extends Error {
  readonly code: StoreLockErrorCode;
  readonly lockPath: string;

  constructor(options: { code: StoreLockErrorCode; message: string; lockPath: string }) {
    super(options.message);
    this.code = options.code;
    this.lockPath = options.lockPath;
    this.name = "StoreLockError";
  }
}

/** The operating-system identity a lock belongs to: a user, and on Windows the user's SID. */
export type StoreLockIdentity = {
  readonly sid?: string;
  readonly uid?: number;
};

/** Who holds a lock: their identity, process, host and window, and when they took it. */
export type StoreLockOwner = {
  pid: number;
  hostname: string;
  windowId: string;
  acquiredAt: number;
  uid: number | undefined;
  sid: string | undefined;
};

/** The file operations the lock needs, so it can be exercised against a filesystem that is not the real one. */
export type StoreLockFs = {
  readFile(targetPath: string, encoding: "utf8"): Promise<string>;
  stat(targetPath: string): Promise<{ mtimeMs: number }>;
  unlink(targetPath: string): Promise<void>;
  utimes(targetPath: string, atime: Date, mtime: Date): Promise<void>;
  writeLockExclusive(targetPath: string, data: string, mode: number): Promise<void>;
};

/** What a caller may say about the lock it wants; every optional part has a default taken from this process. */
export type TryAcquireStoreLockOptions = {
  readonly lockPath: string;
  readonly windowId: string;
  readonly fs?: StoreLockFs;
  readonly hostname?: string;
  readonly identity?: StoreLockIdentity;
  readonly mtimeUpdateMs?: number;
  readonly now?: () => number;
  readonly pid?: number;
  readonly processExists?: (pid: number) => boolean;
  readonly staleLockMs?: number;
  readonly staleRecheckDelayMs?: number;
};

/** The same options with every default resolved, which is what the implementation works with. */
type ResolvedStoreLockOptions = {
  readonly lockPath: string;
  readonly windowId: string;
  readonly hostname: string;
  readonly identity: { readonly uid: number | undefined; readonly sid: string | undefined };
  readonly now: () => number;
  readonly pid: number;
  readonly processExists: (pid: number) => boolean;
  readonly staleLockMs: number;
  readonly staleRecheckDelayMs: number;
  readonly mtimeUpdateMs: number;
  readonly fs: StoreLockFs;
};

/** A held lock: the resolved options and owner it was created with, refreshed until released or distrusted. */
export class StoreLock {
  private heartbeat: NodeJS.Timeout | undefined;
  private released = false;
  private distrusted = false;

  constructor(
    private readonly options: ResolvedStoreLockOptions,
    private readonly owner: StoreLockOwner,
  ) {
    if (options.mtimeUpdateMs > 0) this.heartbeat = beginLockHeartbeat(this, options.mtimeUpdateMs);
  }

  /** Whether this process still holds the lockfile: it exists and it names this owner. */
  async verifyStillOwned(): Promise<boolean> {
    if (this.released) return false;
    const lockOwner = await readLockOwner(this.options.lockPath, { fs: this.options.fs, throwOnInvalid: false });
    return lockOwner !== undefined && sameHold(lockOwner, this.owner);
  }

  /** Give up refreshing: a lock that knows it is distrusted is not refreshed again. */
  markUnhealthy(): void {
    this.distrusted = true;
    this.clearTimer();
  }

  /** Release the lockfile when this process still owns it, then stop the heartbeat. */
  async dispose(): Promise<void> {
    if (this.released) return;
    this.released = true;
    this.clearTimer();
    const lockOwner = await readLockOwner(this.options.lockPath, { fs: this.options.fs, throwOnInvalid: false });
    if (lockOwner !== undefined && sameHold(lockOwner, this.owner)) {
      await ignoreMissingFile(() => this.options.fs.unlink(this.options.lockPath));
    }
  }

  /** Refresh the lockfile's modification time while the lock still looks like ours. */
  async refreshMtime(): Promise<void> {
    if (this.released || this.distrusted) return;
    const lockOwner = await readLockOwner(this.options.lockPath, this.options);
    if (this.released || this.distrusted) return;
    if (lockOwner === undefined || !sameHold(lockOwner, this.owner)) {
      this.clearTimer();
      return;
    }
    const now = new Date(this.options.now());
    await ignoreMissingFile(() => this.options.fs.utimes(this.options.lockPath, now, now));
  }

  private clearTimer(): void {
    if (this.heartbeat !== undefined) clearInterval(this.heartbeat);
  }
}

/** Start the refresh interval for a held lock; it never keeps the process alive by itself. */
function beginLockHeartbeat(lock: StoreLock, everyMs: number): NodeJS.Timeout {
  const heartbeat = setInterval(() => {
    // A refresh that fails stops the heartbeat rather than retrying forever.
    void lock.refreshMtime().catch(() => (lock as unknown as { clearTimer(): void }).clearTimer());
  }, everyMs);
  heartbeat.unref?.();
  return heartbeat;
}

/** Taking a lock either produces it, or says who has it (nobody, or a live owner). */
export type TryAcquireStoreLockResult =
  | { readonly kind: "acquired"; readonly lock: StoreLock }
  | { readonly kind: "held"; readonly owner: StoreLockOwner | undefined };

/** Make sure the lockfile's directory is ours, then take the lock or say who holds it. */
export async function tryAcquireStoreLock(options: TryAcquireStoreLockOptions): Promise<TryAcquireStoreLockResult> {
  const resolved = resolvedOptionsFor(options);
  prepareLockFile(resolved.lockPath);
  return attemptAcquire(resolved, false);
}

/** Read who holds the lock, when the holder is this identity, still alive and not stale. */
export async function readActiveStoreLockOwner(
  options: Omit<TryAcquireStoreLockOptions, "windowId">,
): Promise<StoreLockOwner | undefined> {
  const resolved = resolvedOptionsFor({ ...options, windowId: "read-active-owner", mtimeUpdateMs: 0 });
  assertNoSymlinkInPath(resolved.lockPath);
  const owner = await readLockOwner(resolved.lockPath, { fs: resolved.fs, throwOnInvalid: false });
  if (owner === undefined) return undefined;
  requireSameIdentity(owner, resolved);
  if (!resolved.processExists(owner.pid)) return undefined;
  const lockAge = resolved.now() - await lockfileMtime(resolved);
  if (lockAge > resolved.staleLockMs) return undefined;
  const verifiedOwner = await readLockOwner(resolved.lockPath, { fs: resolved.fs, throwOnInvalid: false });
  return verifiedOwner !== undefined && sameHold(owner, verifiedOwner) ? owner : undefined;
}

/** The identity this process holds locks under: a uid on Unix, a SID on Windows. */
export function getCurrentStoreLockIdentity(platform: NodeJS.Platform = process.platform): StoreLockIdentity {
  if (platform === "win32") return { sid: windowsUserSid() };
  const uid = process.geteuid?.();
  if (uid === undefined) {
    throw new StoreLockError({
      code: "missing_identity",
      message: "Could not determine current uid for store lock",
      lockPath: "",
    });
  }
  return { uid };
}

/** Make the lockfile's directory a secure chain and refuse a symlinked lockfile. */
function prepareLockFile(lockPath: string): void {
  ensureSecureDirectoryChain(path.dirname(lockPath));
  assertNoSymlinkInPath(lockPath);
}

/** Take the lock: create it, or explain why the existing one is not ours to take yet. */
async function attemptAcquire(options: ResolvedStoreLockOptions, isSecondAttempt: boolean): Promise<TryAcquireStoreLockResult> {
  const owner = ownerRecord(options);
  try {
    await options.fs.writeLockExclusive(options.lockPath, JSON.stringify(owner), LOCKFILE_PRIVATE_MODE);
    return { kind: "acquired", lock: new StoreLock(options, owner) };
  } catch (error) {
    if (!(error instanceof Error) || errorCodeOf(error) !== "EEXIST") throw error;
  }
  const lockOwner = await readLockOwner(options.lockPath, { fs: options.fs, throwOnInvalid: false });
  if (lockOwner === undefined) {
    if (isSecondAttempt) return { kind: "held", owner: undefined };
    return retryAfterRemovingStale(options);
  }
  requireSameIdentity(lockOwner, options);
  if (isSecondAttempt) return { kind: "held", owner: lockOwner };
  if (!options.processExists(lockOwner.pid)) return retryAfterRemovingStale(options);
  if (options.now() - await lockfileMtime(options) <= options.staleLockMs) return { kind: "held", owner: lockOwner };
  await waitFor(options.staleRecheckDelayMs);
  if (options.now() - await lockfileMtime(options) <= options.staleLockMs) return { kind: "held", owner: lockOwner };
  return retryAfterRemovingStale(options);
}

/** Remove a stale lockfile and try once more; if the second attempt loses, the answer says so. */
async function retryAfterRemovingStale(options: ResolvedStoreLockOptions): Promise<TryAcquireStoreLockResult> {
  await ignoreMissingFile(() => options.fs.unlink(options.lockPath));
  return attemptAcquire(options, true);
}

/** The owner record this process would write: who we are, where we are, and when. */
function ownerRecord(options: ResolvedStoreLockOptions): StoreLockOwner {
  return {
    uid: options.identity.uid,
    sid: options.identity.sid,
    pid: options.pid,
    hostname: options.hostname,
    windowId: options.windowId,
    acquiredAt: options.now(),
  };
}

/** One lockfile read as the owner it names, or the answer that there is nothing to read there. */
async function readLockOwner(
  lockPath: string,
  options: { readonly fs: StoreLockFs; readonly throwOnInvalid?: boolean },
): Promise<StoreLockOwner | undefined> {
  let lockfileText: string;
  try {
    lockfileText = await options.fs.readFile(lockPath, "utf8");
  } catch (error) {
    if (error instanceof Error && errorCodeOf(error) === "ENOENT") return undefined;
    if (error instanceof Error && (errorCodeOf(error) === "EACCES" || errorCodeOf(error) === "EPERM")) {
      if (options.throwOnInvalid === false) return undefined;
      throw lockfileRefusal(`Unreadable agent store lockfile: ${lockPath}`, lockPath);
    }
    throw error;
  }
  let decodedJson: unknown;
  try {
    decodedJson = JSON.parse(lockfileText);
  } catch {
    if (options.throwOnInvalid === false) return undefined;
    throw lockfileRefusal(`Invalid agent store lockfile JSON: ${lockPath}`, lockPath);
  }
  const owner = ownerFromJson(decodedJson);
  if (owner === undefined) {
    if (options.throwOnInvalid === false) return undefined;
    throw lockfileRefusal(`Invalid agent store lockfile lockOwner: ${lockPath}`, lockPath);
  }
  return owner;
}

/** The refusal for a lockfile that cannot be read or understood. */
function lockfileRefusal(message: string, lockPath: string): StoreLockError {
  return new StoreLockError({ code: "invalid_lockfile", message, lockPath });
}

/** The lockfile's modification time, or zero when it is already gone. */
async function lockfileMtime(options: ResolvedStoreLockOptions): Promise<number> {
  try {
    return (await options.fs.stat(options.lockPath)).mtimeMs;
  } catch (error) {
    if (error instanceof Error && errorCodeOf(error) === "ENOENT") return 0;
    throw error;
  }
}

/** Refuse a lock owned by another operating-system identity, naming the field that differs. */
function requireSameIdentity(owner: StoreLockOwner, options: ResolvedStoreLockOptions): void {
  if (owner.uid !== options.identity.uid) {
    throw identityRefusal(`Agent store lock is held by uid ${owner.uid}, expected ${options.identity.uid}`, options.lockPath);
  }
  if (owner.sid !== options.identity.sid) {
    throw identityRefusal(`Agent store lock is held by sid ${owner.sid}, expected ${options.identity.sid}`, options.lockPath);
  }
}

/** The refusal for a lock held under another identity. */
function identityRefusal(message: string, lockPath: string): StoreLockError {
  return new StoreLockError({ code: "foreign_identity_lock", message, lockPath });
}

/** Whether two owner records name the same hold: process, host, window and the moment it was taken. */
function sameHold(left: StoreLockOwner, right: StoreLockOwner): boolean {
  return left.pid === right.pid
    && left.hostname === right.hostname
    && left.windowId === right.windowId
    && left.acquiredAt === right.acquiredAt;
}

/** Fill in what the caller left out from this process and the platform's defaults. */
function resolvedOptionsFor(options: TryAcquireStoreLockOptions): ResolvedStoreLockOptions {
  const identity = options.identity ?? getCurrentStoreLockIdentity();
  return {
    lockPath: path.resolve(options.lockPath),
    windowId: options.windowId,
    hostname: options.hostname ?? os.hostname(),
    identity: { uid: identity.uid, sid: identity.sid },
    now: options.now ?? Date.now,
    pid: options.pid ?? process.pid,
    processExists: options.processExists ?? processIsAlive,
    staleLockMs: options.staleLockMs ?? STORE_LOCK_STALE_MS,
    staleRecheckDelayMs: options.staleRecheckDelayMs ?? 2_000,
    mtimeUpdateMs: options.mtimeUpdateMs ?? STORE_LOCK_MTIME_UPDATE_MS,
    fs: options.fs ?? realLockFs(),
  };
}

/** The real filesystem operations, named once so they can be replaced wholesale. */
function realLockFs(): StoreLockFs {
  return {
    readFile: (targetPath, encoding) => fs.promises.readFile(targetPath, encoding),
    stat: targetPath => fs.promises.stat(targetPath),
    unlink: targetPath => fs.promises.unlink(targetPath),
    utimes: (targetPath, atime, mtime) => fs.promises.utimes(targetPath, atime, mtime),
    writeLockExclusive: (targetPath, data, mode) => writeLockFileExclusive(targetPath, data, mode),
  };
}

/** The current Windows identity's SID, read from the platform's own user query. */
function windowsUserSid(): string {
  const output = String(execFileSync("whoami", ["/user", "/fo", "csv", "/nh"], { encoding: "utf8" })).trim();
  const sid = output.split(",").map(field => field.replace(/^"|"$/g, "")).at(-1);
  if (sid === undefined || sid.length === 0) {
    throw new StoreLockError({
      code: "missing_identity",
      message: "Could not determine current Windows lock identity",
      lockPath: "",
    });
  }
  return sid;
}

/** Whether a process with this id exists: signal 0 asks, and a permission refusal still means it exists. */
function processIsAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return error instanceof Error && errorCodeOf(error) === "EPERM";
  }
}

/** Run an operation whose file may already be gone. */
async function ignoreMissingFile(operation: () => Promise<void>): Promise<void> {
  try {
    await operation();
  } catch (error) {
    if (!(error instanceof Error) || errorCodeOf(error) !== "ENOENT") throw error;
  }
}

/** Wait before a stale-lock recheck; a zero or negative wait is no wait at all. */
async function waitFor(ms: number): Promise<void> {
  if (ms <= 0) return;
  await new Promise<void>(resolve => setTimeout(resolve, ms));
}

/** A decodedJson lockfile as an owner record, or undefined when a field is missing or the wrong type. */
function ownerFromJson(value: unknown): StoreLockOwner | undefined {
  if (!isPlainRecord(value)) return undefined;
  const { pid, hostname, windowId, acquiredAt, uid, sid } = value;
  const identifiable = typeof pid === "number"
    && typeof hostname === "string"
    && typeof windowId === "string"
    && typeof acquiredAt === "number"
    && (uid === undefined || typeof uid === "number")
    && (sid === undefined || typeof sid === "string");
  if (!identifiable) return undefined;
  return { pid, hostname, windowId, acquiredAt, uid, sid };
}

/** Whether a decodedJson JSON value is a plain record rather than a scalar or an array. */
function isPlainRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** The platform error code a failure carries, when it carries one. */
function errorCodeOf(error: Error): string | undefined {
  if ("code" in error && typeof error.code === "string") return error.code;
  return undefined;
}
