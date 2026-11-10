/**
 * Opening a file in a store without leaving it.
 *
 * The path is checked, the file is opened and then identified again through the handle that was opened, so a file that
 * was swapped between the check and the open is refused rather than read.
 */
import * as fs from "node:fs";
import * as path from "node:path";
import { AgentStorePathError } from "./paths.ts";

/** The code every refusal this module raises is reported under. */
const SYMLINK_REFUSED = "symlink_refused" as const;

/** The errno codes a no-follow open reports when the way is a symlink. */
const SYMLINK_REFUSAL_CODES: ReadonlySet<string> = new Set(["ELOOP", "EMLINK"]);

/** What identifies one filesystem object: its device and its inode. */
interface FileIdentity {
  readonly device: number;
  readonly inode: number;
}

/** An opened sqlite path, with the checks that guard it and the way to close it. */
export interface SecureSqlitePath {
  readonly sqlitePath: string;
  readonly verifyOpenedInode: () => void;
  readonly close: () => void;
}

/** Opens a resolved sqlite path without following a symlink on the way to it, and identifies it again through its handle. */
export function openSecureSqlitePath(targetPath: string, mode: number): SecureSqlitePath {
  const parentDirectory = path.dirname(targetPath);
  const parentFd = openParentDirectory(parentDirectory);
  let parentFdKeptForCaller = false;
  try {
    const parentStat = fs.fstatSync(parentFd);
    if (!parentStat.isDirectory()) {
      throw refuse(`Refusing to open sqlite under non-directory parent: ${parentDirectory}`, parentDirectory);
    }
    const parentIdentity = identityOf(parentStat);
    assertParentDirectoryIsThePath(parentIdentity, parentDirectory);
    const leafIdentity = identifyLeaf(targetPath, mode);
    let verified = false;
    let closed = false;
    const close = (): void => {
      if (closed) return;
      closed = true;
      fs.closeSync(parentFd);
    };
    const verifyOpenedInode = (): void => {
      if (verified) return;
      assertParentDirectoryIsThePath(parentIdentity, parentDirectory);
      assertLeafIdentity(targetPath, leafIdentity);
      verified = true;
    };
    parentFdKeptForCaller = true;
    return { sqlitePath: targetPath, verifyOpenedInode, close };
  } finally {
    if (!parentFdKeptForCaller) fs.closeSync(parentFd);
  }
}

/** Writes a lock file, refusing a symlinked one and never replacing an existing one. */
export async function writeLockFileExclusive(lockTarget: string, body: string, mode: number): Promise<void> {
  const flags = symlinkSafeExclusiveWriteFlags();
  let fd: fs.promises.FileHandle | undefined;
  try {
    fd = await fs.promises.open(lockTarget, flags, mode);
    assertCanonicalPath(lockTarget);
    await fd.writeFile(body, { encoding: "utf8" });
  } catch (error) {
    if (isSymlinkRefusal(error)) {
      throw refuse(`Refusing to create lockfile at symlinked path: ${lockTarget}`, lockTarget);
    }
    throw error;
  } finally {
    await fd?.close();
  }
}

/** The identity of the leaf, read through the handle it was opened with. */
function identifyLeaf(targetPath: string, mode: number): FileIdentity {
  const leafFd = openLeafFile(targetPath, mode);
  try {
    const leafStat = fs.fstatSync(leafFd);
    if (!leafStat.isFile()) {
      throw refuse(`Refusing to open non-regular sqlite path: ${targetPath}`, targetPath);
    }
    assertCanonicalPath(targetPath);
    return identityOf(leafStat);
  } finally {
    fs.closeSync(leafFd);
  }
}

/** Opens the file that will be the store's sqlite file, creating it when it is not there. */
function openLeafFile(targetPath: string, mode: number): number {
  const flags = symlinkSafeOpenCreateFlags();
  try {
    return fs.openSync(targetPath, flags, mode);
  } catch (error) {
    if (isSymlinkRefusal(error)) throw refuse(`Refusing to open symlinked path: ${targetPath}`, targetPath);
    throw error;
  }
}

/** Opens the directory the file lives in, without following a symlink. */
function openParentDirectory(parentDirectory: string): number {
  const flags = symlinkSafeDirectoryOpenFlags();
  try {
    return fs.openSync(parentDirectory, flags);
  } catch (error) {
    if (isSymlinkRefusal(error) || (isNodeError(error) && error.code === "ENOTDIR" && isSymbolicLink(parentDirectory))) {
      throw refuse(`Refusing to open sqlite under symlinked parent: ${parentDirectory}`, parentDirectory);
    }
    throw error;
  }
}

/** Whether a path names a symlink, when it can be looked at at all. */
function isSymbolicLink(targetPath: string): boolean {
  try {
    return fs.lstatSync(targetPath).isSymbolicLink();
  } catch {
    return false;
  }
}

/** Refuses a path whose realpath is not the path itself: a symlink somewhere on the way to it. */
function assertCanonicalPath(targetPath: string): void {
  let realpath: string;
  try {
    realpath = fs.realpathSync.native(targetPath);
  } catch (error) {
    throw refuse(
      `Unable to resolve realpath for ${targetPath}: ${error instanceof Error ? error.message : String(error)}`,
      targetPath,
    );
  }
  if (realpath !== targetPath) {
    throw refuse(`Refusing path with symlinked parent: ${targetPath} -> ${realpath}`, targetPath);
  }
}

/** Refuses a leaf whose identity is no longer the one it was opened with. */
function assertLeafIdentity(targetPath: string, expected: FileIdentity): void {
  const flags = symlinkSafeReopenFlags();
  let fd: number;
  try {
    fd = fs.openSync(targetPath, flags);
  } catch (error) {
    if (isSymlinkRefusal(error)) {
      throw refuse(`Sqlite path became symlinked between open and verification: ${targetPath}`, targetPath);
    }
    throw error;
  }
  try {
    const stat = fs.fstatSync(fd);
    assertCanonicalPath(targetPath);
    if (!sameIdentity(identityOf(stat), expected)) {
      throw refuse(
        `Sqlite path inode drifted between open and verification (expected dev=${expected.device} ino=${expected.inode}, got dev=${stat.dev} ino=${stat.ino}): ${targetPath}`,
        targetPath,
      );
    }
  } finally {
    fs.closeSync(fd);
  }
}

/** Refuses a parent directory that is now a symlink or another object than the one it was. */
function assertParentDirectoryIsThePath(expected: FileIdentity, parentDirectory: string): void {
  let pathStat: fs.Stats;
  try {
    pathStat = fs.lstatSync(parentDirectory);
  } catch (error) {
    throw refuse(
      `Unable to lstat parent directory ${parentDirectory}: ${error instanceof Error ? error.message : String(error)}`,
      parentDirectory,
    );
  }
  if (pathStat.isSymbolicLink()) {
    throw refuse(`Parent directory became symlinked between open and verification: ${parentDirectory}`, parentDirectory);
  }
  if (!sameIdentity(identityOf(pathStat), expected)) {
    throw refuse(
      `Parent directory inode drifted between open and verification (expected dev=${expected.device} ino=${expected.inode}, got dev=${pathStat.dev} ino=${pathStat.ino}): ${parentDirectory}`,
      parentDirectory,
    );
  }
}

/** The fs constants this build has, including the close-on-exec bit older typings leave out. */
type FsConstants = typeof fs.constants & { O_CLOEXEC?: number };
const constants = fs.constants as FsConstants;

/** The flags for opening or creating the store's sqlite file without following a symlink. */
function symlinkSafeOpenCreateFlags(): number {
  return orPresentBits(constants.O_RDWR ?? 0, [constants.O_CREAT, constants.O_NOFOLLOW, constants.O_CLOEXEC]);
}

/** The flags for reopening a file only to identify it again. */
function symlinkSafeReopenFlags(): number {
  return orPresentBits(constants.O_RDONLY ?? 0, [constants.O_NOFOLLOW, constants.O_CLOEXEC]);
}

/** The flags for opening a directory without following a symlink. */
function symlinkSafeDirectoryOpenFlags(): number {
  return orPresentBits(constants.O_RDONLY ?? 0, [constants.O_DIRECTORY, constants.O_NOFOLLOW, constants.O_CLOEXEC]);
}

/** The flags for creating a lock file that cannot be an existing file or a symlink. */
export function symlinkSafeExclusiveWriteFlags(): number {
  return orPresentBits(constants.O_WRONLY ?? 0, [
    constants.O_CREAT,
    constants.O_EXCL,
    constants.O_NOFOLLOW,
    constants.O_CLOEXEC,
  ]);
}

/** Adds the flag bits this build has to the flags asked for. */
function orPresentBits(base: number, bits: ReadonlyArray<number | undefined>): number {
  let flags = base;
  for (const bit of bits) {
    if (typeof bit === "number") flags |= bit;
  }
  return flags;
}

/** Whether a no-follow open on a symlink reports ELOOP, or EPERM where no-follow is expressed another way. */
function isSymlinkRefusal(error: unknown): boolean {
  if (!isNodeError(error) || error.code === undefined) return false;
  return SYMLINK_REFUSAL_CODES.has(error.code) || (error.code === "EPERM" && hasNofollowConstant());
}

/** Whether this build's fs constants carry the no-follow bit. */
function hasNofollowConstant(): boolean {
  return typeof constants.O_NOFOLLOW === "number";
}

/** A path error carrying the refused path and the code this module reports. */
function refuse(message: string, failedPath: string): AgentStorePathError {
  return new AgentStorePathError({ code: SYMLINK_REFUSED, message, failedPath });
}

/** Whether a thrown value is a Node errno error. */
function isNodeError(error: unknown): error is NodeJS.ErrnoException {
  return error instanceof Error && typeof (error as NodeJS.ErrnoException).code === "string";
}

/** The identity of one stat result. */
function identityOf(stat: { dev: number; ino: number }): FileIdentity {
  return { device: stat.dev, inode: stat.ino };
}

/** Whether two identities name the same filesystem object. */
function sameIdentity(actual: FileIdentity, expected: FileIdentity): boolean {
  return actual.device === expected.device && actual.inode === expected.inode;
}
