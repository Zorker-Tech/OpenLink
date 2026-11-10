/**
 * Keeping a store path inside the store.
 *
 * The store is addressed by relative paths, and every one of them is a claim about where bytes may be written. This file
 * is the only place that decides whether such a claim is allowed, and it decides it the same way every time:
 *
 * - **the path is built from segments** — a segment may not be empty, may not be `.` or `..`, may not carry a separator, a
 *   NUL, a control character, or a name Windows would trim or reserve; a path with nothing left after that is not a path;
 * - **the base is a real directory, reached without links** — an absolute base is checked up its whole chain, so a store
 *   under a symlinked directory is refused rather than silently written through the link;
 * - **what was checked stays checked** — a walk or a stat re-reads the directories it passed through and compares device and
 *   inode, so a directory swapped for a link between the check and the read is refused, not followed;
 * - **a refusal carries its reason** — every error names the rule it failed, so a caller can report "this file was skipped
 *   because it is a link" instead of "something went wrong".
 */
import * as fs from "node:fs";
import * as path from "node:path";

export interface UnsafeAgentStorePathErrorOptions {
  readonly code: string;
  readonly message: string;
  readonly relPath?: unknown;
  readonly failedPath?: string | undefined;
}

export class UnsafeAgentStorePathError extends Error {
  readonly code: string;
  readonly relPath: unknown;
  readonly failedPath: string | undefined;

  constructor(options: UnsafeAgentStorePathErrorOptions) {
    super(options.message);
    this.name = "UnsafeAgentStorePathError";
    this.code = options.code;
    this.relPath = options.relPath;
    this.failedPath = options.failedPath;
  }
}

export interface SafeAgentStoreFileEntry {
  readonly relPath: string;
  readonly absPath: string;
  readonly size: number;
  readonly mtimeMs: number;
  readonly dev: number;
  readonly ino: number;
}

export interface SafeAgentStoreRefusal {
  readonly relPath: string;
  readonly reason: "not_regular_file" | "symlink_refused";
}

export interface SafeAgentStoreWalkResult {
  readonly files: SafeAgentStoreFileEntry[];
  readonly refusals: SafeAgentStoreRefusal[];
}

export interface SafeAgentStoreFileSystem {
  lstatSync(path: fs.PathLike): fs.Stats;
  readdirSync(path: fs.PathLike, options: { readonly withFileTypes: true }): fs.Dirent[];
}

const MAX_SEGMENT_LENGTH_BYTES = 255;
/** Device names Windows reserves: a file may never be called one, with or without an extension. */
const WINDOWS_RESERVED = new Set([
  "con", "prn", "aux", "nul",
  "com1", "com2", "com3", "com4", "com5", "com6", "com7", "com8", "com9",
  "lpt1", "lpt2", "lpt3", "lpt4", "lpt5", "lpt6", "lpt7", "lpt8", "lpt9",
]);
const WINDOWS_FORBIDDEN_FILENAME_CHARS = /[<>:"|?*]/;

/** One refusal, in the one shape every check in this file raises. */
function refuse(code: string, message: string, detail: { readonly relPath?: unknown; readonly failedPath?: string } = {}): UnsafeAgentStorePathError {
  return new UnsafeAgentStorePathError({ code, message, ...detail });
}

/** The rules a single segment must satisfy, in the order a reader would ask about them. */
const SEGMENT_RULES: readonly {
  readonly holds: (segment: string) => boolean;
  readonly code: string;
  readonly message: (segment: string) => string;
}[] = [
  {
    holds: (segment) => Buffer.byteLength(segment, "utf8") > MAX_SEGMENT_LENGTH_BYTES,
    code: "invalid_segment",
    message: (segment) => `Agent store path segment exceeds ${MAX_SEGMENT_LENGTH_BYTES} bytes: ${segment}`,
  },
  {
    // A control character in a name is a name nobody meant to write, and a path with one is not portable anywhere.
    holds: (segment) => [...segment].some((character) => {
      const code = character.charCodeAt(0);
      return code < 32 || code === 127;
    }),
    code: "invalid_segment",
    message: (segment) => `Agent store path segment contains control character (0x${segment.charCodeAt([...segment].findIndex((character) => character.charCodeAt(0) < 32 || character.charCodeAt(0) === 127)).toString(16)}): ${segment}`,
  },
  {
    holds: (segment) => segment.endsWith(".") || segment.endsWith(" "),
    code: "invalid_segment",
    message: (segment) => `Agent store path segment must not end with '.' or space (Windows trims these): ${segment}`,
  },
  {
    // `NUL.txt` is still the NUL device on Windows: the stem decides, not the whole name.
    holds: (segment) => WINDOWS_RESERVED.has(segment.toLowerCase().split(".")[0] ?? ""),
    code: "reserved_name",
    message: (segment) => `Agent store path segment uses a reserved device name: ${segment}`,
  },
];

function assertSafeSegment(segment: string, relPath: unknown): void {
  const broken = SEGMENT_RULES.find((rule) => rule.holds(segment));
  if (broken !== undefined) throw refuse(broken.code, broken.message(segment), { relPath });
}

export function normalizeRelPath(relPath: unknown): string {
  if (typeof relPath !== "string" || relPath.length === 0) {
    throw refuse("empty_path", "Agent store relative path must be a non-empty string", { relPath });
  }
  if (relPath.includes("\0")) throw refuse("invalid_segment", "Agent store relative path must not contain NUL bytes", { relPath });
  if (path.posix.isAbsolute(relPath) || path.win32.isAbsolute(relPath)) {
    throw refuse("invalid_segment", `Agent store relative path must not be absolute: ${relPath}`, { relPath });
  }
  const segments: string[] = [];
  for (const raw of relPath.replaceAll("\\", "/").split("/")) {
    if (raw.length === 0 || raw === ".") continue;
    if (raw === "..") throw refuse("invalid_segment", `Agent store relative path must not contain '..': ${relPath}`, { relPath });
    assertSafeSegment(raw, relPath);
    segments.push(raw);
  }
  if (segments.length === 0) throw refuse("empty_path", `Agent store relative path resolved to empty: ${relPath}`, { relPath });
  return segments.join("/");
}

/** A raw directory entry's name, as a segment: same rules, plus it must not carry a separator at all. */
function validateRawSegmentName(name: string): string {
  if (typeof name !== "string" || name.length === 0) throw refuse("empty_path", "Agent store segment name must be a non-empty string", { relPath: name });
  if (name === "." || name === "..") throw refuse("invalid_segment", `Agent store segment name must not be '.' or '..': ${name}`, { relPath: name });
  if (name.includes("/")) throw refuse("invalid_segment", `Agent store segment name must not contain '/': ${name}`, { relPath: name });
  if (name.includes("\\")) throw refuse("invalid_segment", `Agent store segment name must not contain '\\\\': ${name}`, { relPath: name });
  assertSafeSegment(name, name);
  return name;
}

function hasWindowsIncompatibleFilenameChars(relPath: string): boolean {
  return relPath.split("/").some((segment) => segment.length > 0 && WINDOWS_FORBIDDEN_FILENAME_CHARS.test(segment));
}

/** A path that Windows cannot materialise is refused only on Windows: elsewhere those characters are ordinary. */
export function assertWindowsMaterializableRelPath({ relPath, platform: platformName = process.platform }: { readonly relPath: string; readonly platform?: NodeJS.Platform | undefined }): void {
  if (platformName !== "win32" || !hasWindowsIncompatibleFilenameChars(relPath)) return;
  throw refuse("windows_incompatible", `Agent store path is not materializable on Windows (illegal filename character < > : " | ? *): ${relPath}`, { relPath });
}

function isEqualOrParent({ parent, candidate }: { parent: string; candidate: string }): boolean {
  if (candidate === parent) return true;
  return candidate.startsWith(parent.endsWith(path.sep) ? parent : parent + path.sep);
}

export function resolveSafeChildPath({ base, relPath }: { readonly base: string; readonly relPath: unknown }): string {
  if (!path.isAbsolute(base)) throw refuse("outside_base", `Agent store base must be absolute: ${base}`, { relPath });
  const normalized = normalizeRelPath(relPath);
  const resolvedBase = path.resolve(base);
  const resolved = path.resolve(resolvedBase, normalized);
  if (!isEqualOrParent({ parent: resolvedBase, candidate: resolved })) {
    throw refuse("outside_base", `Agent store relative path resolves outside the base: ${relPath}`, { relPath, failedPath: resolved });
  }
  return resolved;
}

function isNodeError(error: unknown): error is NodeJS.ErrnoException {
  return error instanceof Error && typeof (error as NodeJS.ErrnoException).code === "string";
}

/** An lstat that answers "absent" instead of throwing, and lets every other error through. */
function lstatOrAbsent(fsModule: SafeAgentStoreFileSystem, target: string): fs.Stats | undefined {
  try {
    return fsModule.lstatSync(target);
  } catch (error) {
    if (isNodeError(error) && error.code === "ENOENT") return undefined;
    throw error;
  }
}

/** A directory that was read: its device and inode, so it can be recognised again after the read. */
interface DirectoryIdentity {
  readonly abs: string;
  readonly rel: string;
  readonly dev: number;
  readonly ino: number;
}

function identityOf(abs: string, rel: string, stat: fs.Stats): DirectoryIdentity {
  return { abs, rel, dev: stat.dev, ino: stat.ino };
}

/** Whether a stat is still the same directory: a link, another device or another inode means it is not. */
function sameDirectory(stat: fs.Stats, identity: DirectoryIdentity): boolean {
  return !stat.isSymbolicLink() && stat.isDirectory() && stat.dev === identity.dev && stat.ino === identity.ino;
}

/** Whether the base may be written at all: absolute, reached without links, and a directory rather than a link or a file. */
function assertSafeBase(base: string, fsModule: SafeAgentStoreFileSystem, what: "walk" | "stat"): string {
  if (!path.isAbsolute(base)) {
    throw what === "walk"
      ? refuse("outside_base", `safeWalk base must be absolute: ${base}`, { failedPath: base })
      : refuse("outside_base", `Agent store base must be absolute: ${base}`, { relPath: base });
  }
  const resolvedBase = path.resolve(base);
  assertAncestorChainNoSymlinks(resolvedBase, fsModule);
  const baseStat = fsModule.lstatSync(resolvedBase);
  if (baseStat.isSymbolicLink()) {
    throw refuse("symlink_refused", `Refusing to ${what} ${what === "walk" ? "symlinked" : "under symlinked"} agent store base: ${resolvedBase}`, { failedPath: resolvedBase });
  }
  if (!baseStat.isDirectory()) {
    throw refuse("not_regular_file", `${what === "walk" ? "safeWalk base is not a directory" : "Agent store base is not a directory"}: ${resolvedBase}`, { failedPath: resolvedBase });
  }
  return resolvedBase;
}

/**
 * The whole chain above a path, checked once: a store under a symlinked directory is refused, because writing through the
 * link is exactly what the caller did not ask for.
 */
function assertAncestorChainNoSymlinks(absPath: string, fsModule: SafeAgentStoreFileSystem): void {
  const parsed = path.parse(absPath);
  let current = parsed.root;
  for (const segment of absPath.slice(parsed.root.length).split(path.sep).filter((part) => part.length > 0)) {
    current = path.join(current, segment);
    const stat = lstatOrAbsent(fsModule, current);
    // An ancestor that is absent ends the chain: the walk below will report the missing directory itself.
    if (stat === undefined) return;
    if (stat.isSymbolicLink()) {
      throw refuse("symlink_refused", `Refusing to walk agent store path whose ancestor is a symlink: ${current}`, { failedPath: current });
    }
  }
}

function posixJoin({ dir, segment }: { readonly dir: string; readonly segment: string }): string {
  return dir.length === 0 ? segment : `${dir}/${segment}`;
}

/** One thing the walk still has to do, in the order it must happen. */
type WalkTask =
  | { readonly kind: "directory"; readonly identity: DirectoryIdentity }
  | { readonly kind: "file"; readonly entry: SafeAgentStoreFileEntry }
  | { readonly kind: "refusal"; readonly relPath: string; readonly reason: SafeAgentStoreRefusal["reason"] };

/**
 * Everything under a store's base, refused file by file rather than thrown: one bad entry does not stop a walk.
 *
 * The walk is depth first and in readdir order — a directory's contents appear where the directory did among its siblings —
 * which is why the work is a stack of tasks rather than a stack of directories: each entry keeps its place in the order.
 */
export function safeWalk(base: string, options: { readonly fs?: SafeAgentStoreFileSystem | undefined } = {}): SafeAgentStoreWalkResult {
  const fsModule = options.fs ?? fs;
  const resolvedBase = assertSafeBase(base, fsModule, "walk");
  const baseStat = fsModule.lstatSync(resolvedBase);
  const result: SafeAgentStoreWalkResult = { files: [], refusals: [] };
  const tasks: WalkTask[] = [{ kind: "directory", identity: identityOf(resolvedBase, "", baseStat) }];
  while (tasks.length > 0) {
    const task = tasks.pop()!;
    if (task.kind === "file") {
      result.files.push(task.entry);
      continue;
    }
    if (task.kind === "refusal") {
      result.refusals.push({ relPath: task.relPath, reason: task.reason });
      continue;
    }
    const directory = task.identity;
    const relDir = directory.rel.length === 0 ? "." : directory.rel;
    // The directory is read only while it is still the directory that was found: a swapped one is a refusal, not a read.
    const before = lstatOrAbsent(fsModule, directory.abs);
    if (before === undefined || !sameDirectory(before, directory)) {
      result.refusals.push({ relPath: relDir, reason: before?.isSymbolicLink() === true ? "symlink_refused" : "not_regular_file" });
      continue;
    }
    let entries: fs.Dirent[];
    try {
      entries = fsModule.readdirSync(directory.abs, { withFileTypes: true });
    } catch (error) {
      if (isNodeError(error) && error.code === "ENOENT") {
        result.refusals.push({ relPath: relDir, reason: "not_regular_file" });
        continue;
      }
      throw error;
    }
    const after = lstatOrAbsent(fsModule, directory.abs);
    if (after === undefined || !sameDirectory(after, directory)) {
      result.refusals.push({ relPath: relDir, reason: after?.isSymbolicLink() === true ? "symlink_refused" : "not_regular_file" });
      continue;
    }
    const children: WalkTask[] = [];
    for (const entry of entries) {
      if (entry.name === "." || entry.name === "..") continue;
      let segment: string;
      try {
        segment = validateRawSegmentName(entry.name);
      } catch {
        // A name this store cannot hold is skipped and counted, not thrown: the walk reports what it could read.
        children.push({ kind: "refusal", relPath: posixJoin({ dir: directory.rel, segment: entry.name }), reason: "not_regular_file" });
        continue;
      }
      const childRel = posixJoin({ dir: directory.rel, segment });
      const childAbs = path.join(directory.abs, segment);
      if (!isEqualOrParent({ parent: resolvedBase, candidate: childAbs })) {
        children.push({ kind: "refusal", relPath: childRel, reason: "not_regular_file" });
        continue;
      }
      const childStat = lstatOrAbsent(fsModule, childAbs);
      if (childStat === undefined) continue;
      if (childStat.isSymbolicLink()) {
        children.push({ kind: "refusal", relPath: childRel, reason: "symlink_refused" });
        continue;
      }
      if (childStat.isDirectory()) {
        children.push({ kind: "directory", identity: identityOf(childAbs, childRel, childStat) });
        continue;
      }
      if (!childStat.isFile()) {
        children.push({ kind: "refusal", relPath: childRel, reason: "not_regular_file" });
        continue;
      }
      children.push({ kind: "file", entry: { relPath: childRel, absPath: childAbs, size: childStat.size, mtimeMs: childStat.mtimeMs, dev: childStat.dev, ino: childStat.ino } });
    }
    // Reversed, so the first entry is the first one popped: the walk's order is part of what a caller sees.
    for (let index = children.length - 1; index >= 0; index -= 1) tasks.push(children[index]!);
  }
  return result;
}

export type SafeStatChildResult =
  | { readonly kind: "absent" }
  | { readonly kind: "refused"; readonly refusal: SafeAgentStoreRefusal }
  | { readonly kind: "file"; readonly entry: SafeAgentStoreFileEntry };

/**
 * One child of a store, with every directory between the base and it checked twice: once to find it, and once again after,
 * so a directory replaced by a link in the meantime is a refusal rather than a read through the link.
 */
export function safeStatChild({ base, relPath, fs: fsOverride }: { readonly base: string; readonly relPath: unknown; readonly fs?: SafeAgentStoreFileSystem | undefined }): SafeStatChildResult {
  const fsModule = fsOverride ?? fs;
  const absPath = resolveSafeChildPath({ base, relPath });
  const resolvedBase = assertSafeBase(base, fsModule, "stat");
  const normalized = normalizeRelPath(relPath);
  const segments = normalized.split("/");
  const passed: DirectoryIdentity[] = [];
  let currentAbs = resolvedBase;
  let currentRel = "";
  for (const segment of segments.slice(0, -1)) {
    currentAbs = path.join(currentAbs, segment);
    currentRel = posixJoin({ dir: currentRel, segment });
    const stat = lstatOrAbsent(fsModule, currentAbs);
    if (stat === undefined) return { kind: "absent" };
    if (stat.isSymbolicLink()) return { kind: "refused", refusal: { relPath: currentRel, reason: "symlink_refused" } };
    if (!stat.isDirectory()) return { kind: "refused", refusal: { relPath: currentRel, reason: "not_regular_file" } };
    passed.push(identityOf(currentAbs, currentRel, stat));
  }
  for (const directory of passed) {
    const stat = lstatOrAbsent(fsModule, directory.abs);
    if (stat === undefined) return { kind: "absent" };
    if (!sameDirectory(stat, directory)) {
      return { kind: "refused", refusal: { relPath: directory.rel, reason: stat.isSymbolicLink() ? "symlink_refused" : "not_regular_file" } };
    }
  }
  const leafStat = lstatOrAbsent(fsModule, absPath);
  if (leafStat === undefined) return { kind: "absent" };
  if (leafStat.isSymbolicLink()) return { kind: "refused", refusal: { relPath: normalized, reason: "symlink_refused" } };
  if (!leafStat.isFile()) return { kind: "refused", refusal: { relPath: normalized, reason: "not_regular_file" } };
  return { kind: "file", entry: { relPath: normalized, absPath, size: leafStat.size, mtimeMs: leafStat.mtimeMs, dev: leafStat.dev, ino: leafStat.ino } };
}
