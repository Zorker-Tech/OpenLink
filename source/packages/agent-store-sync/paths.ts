/**
 * Where an agent store keeps its own files, and which paths in it are reserved.
 *
 * A store is a directory the platform reads and writes, and some of what lives in it — the synchronisation state and a
 * prefix reserved for the platform — is not part of what a user sees, so a path inside it is checked before it is used.
 */
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import {
  AGENT_STORE_RESERVED_PATH_PREFIX,
  isAgentStoreId,
  isAgentStoreShareMountKey,
  isCloudAgentStoreId,
  isValidBareUuid,
  parseTeamAgentStoreSourceId,
  parseUserAgentStoreSourceId,
} from "../constants/agent-store-ids.ts";

export const AGENT_STORE_SYNC_DIR_NAME = ".sync";

export function isReservedRelPath(relativePathName: string): boolean {
  return relativePathName.split("/").some(isReservedRelPathSegment);
}

export function isReservedRelPathSegment(segment: string): boolean {
  return segment.slice(0, AGENT_STORE_RESERVED_PATH_PREFIX.length).toLowerCase()
    === AGENT_STORE_RESERVED_PATH_PREFIX;
}

export const AGENT_STORE_CONFLICT_EVENTS_FILE_NAME = "conflict-events.jsonl";
export const AGENT_STORE_CONFLICT_PENDING_FILE_NAME = "conflict-events.pending.jsonl";
const SECURE_DIRECTORY_MODE = 0o700;

export type AgentStoreSourceKind = "user" | "team" | "cloud" | "local" | "store" | "unknown";

export function classifyAgentStoreSourceId(sourceId: string): AgentStoreSourceKind {
  if (parseUserAgentStoreSourceId(sourceId) !== undefined) return "user";
  if (parseTeamAgentStoreSourceId(sourceId) !== undefined) return "team";
  if (isCloudAgentStoreId(sourceId)) return "cloud";
  if (isValidBareUuid(sourceId)) return "local";
  if (isAgentStoreId(sourceId) || isAgentStoreShareMountKey(sourceId)) return "store";
  return "unknown";
}

export type AgentStorePathErrorCode = "symlink_refused" | "invalid_store_base" | "not_directory";

export class AgentStorePathError extends Error {
  readonly code: AgentStorePathErrorCode;
  readonly failedPath: string;

  constructor(settings: { code: AgentStorePathErrorCode; message: string; failedPath: string }) {
    super(settings.message);
    this.name = "AgentStorePathError";
    this.code = settings.code;
    this.failedPath = settings.failedPath;
  }
}

type PathFileSystem = Pick<typeof fs, "lstatSync" | "mkdirSync">;

export interface AgentStorePathOptions {
  readonly env?: NodeJS.ProcessEnv;
  readonly fs?: PathFileSystem;
  readonly geteuid?: (() => number) | undefined;
  readonly osTmpdir?: () => string;
  readonly path?: typeof path;
  readonly platform?: NodeJS.Platform;
  readonly windowsAcl?: Record<string, unknown>;
  readonly trustedBase?: string;
}

interface ResolvedDeps {
  readonly env: NodeJS.ProcessEnv;
  readonly fs: PathFileSystem;
  readonly geteuid: (() => number) | undefined;
  readonly osTmpdir: () => string;
  readonly path: typeof path;
  readonly platform: NodeJS.Platform;
  readonly windowsAcl: Record<string, unknown>;
}

export function assertNoSymlinkInPath(targetPath: string, settings: AgentStorePathOptions = {}): void {
  const resolvedDeps = resolvePathDeps(settings);
  const absoluteTarget = resolvedDeps.path.resolve(targetPath);
  const pathChain = splitPathChain(absoluteTarget, resolvedDeps.path);
  for (const segment of pathChain) {
    const fileStat = readLstat(segment, resolvedDeps.fs);
    if (!fileStat) return;
    if (fileStat.isSymbolicLink()) {
      throw new AgentStorePathError({
        code: "symlink_refused",
        message: `Refusing to use symlinked agent store path: ${segment}`,
        failedPath: segment,
      });
    }
  }
}

export function ensureSecureDirectoryChain(targetDir: string, settings: AgentStorePathOptions = {}): void {
  const resolvedDeps = resolvePathDeps(settings);
  const resolvedTarget = resolvedDeps.path.resolve(targetDir);
  const trustedBase = settings.trustedBase !== undefined
    ? resolvedDeps.path.resolve(settings.trustedBase)
    : trustedAncestor(resolvedTarget, resolvedDeps);
  if (resolvedTarget === trustedBase) {
    validateRealSegment(trustedBase, resolvedDeps);
    return;
  }
  const relativeToBase = resolvedDeps.path.relative(trustedBase, resolvedTarget);
  if (relativeToBase.length === 0 || relativeToBase.startsWith("..") || resolvedDeps.path.isAbsolute(relativeToBase)) {
    throw new AgentStorePathError({
      code: "invalid_store_base",
      message: `Refusing to create ${resolvedTarget} outside trusted base ${trustedBase}`,
      failedPath: resolvedTarget,
    });
  }
  const pathChain = relativeToBase.split(resolvedDeps.path.sep).filter((segment) => segment.length > 0);
  let currentDirectory = trustedBase;
  for (const segment of pathChain) {
    validateRealSegment(currentDirectory, resolvedDeps);
    currentDirectory = resolvedDeps.path.join(currentDirectory, segment);
    createRealSegment(currentDirectory, resolvedDeps);
  }
}

function resolvePathDeps(settings: AgentStorePathOptions): ResolvedDeps {
  return {
    env: settings.env ?? process.env,
    fs: settings.fs ?? fs,
    geteuid: settings.geteuid ?? process.geteuid?.bind(process),
    osTmpdir: settings.osTmpdir ?? os.tmpdir,
    path: settings.path ?? path,
    platform: settings.platform ?? process.platform,
    windowsAcl: settings.windowsAcl ?? {},
  };
}

function validateDirectoryStat(targetPath: string, fileStat: fs.Stats): void {
  if (fileStat.isSymbolicLink()) {
    throw new AgentStorePathError({
      code: "symlink_refused",
      message: `Refusing to use symlinked agent store path: ${targetPath}`,
      failedPath: targetPath,
    });
  }
  if (!fileStat.isDirectory()) {
    throw new AgentStorePathError({
      code: "not_directory",
      message: `Agent store path is not a directory: ${targetPath}`,
      failedPath: targetPath,
    });
  }
}

function trustedAncestor(targetPath: string, resolvedDeps: ResolvedDeps): string {
  const pathChain = splitPathChain(resolvedDeps.path.resolve(targetPath), resolvedDeps.path);
  let trusted = pathChain[0] ?? resolvedDeps.path.resolve(targetPath);
  for (let index = 1; index < pathChain.length; index += 1) {
    const segment = pathChain[index];
    if (segment === undefined) continue;
    const fileStat = readLstat(segment, resolvedDeps.fs);
    if (!fileStat) break;
    if (fileStat.isSymbolicLink()) {
      throw new AgentStorePathError({
        code: "symlink_refused",
        message: `Refusing to use symlinked agent store path: ${segment}`,
        failedPath: segment,
      });
    }
    if (!fileStat.isDirectory()) {
      throw new AgentStorePathError({
        code: "not_directory",
        message: `Agent store path is not a directory: ${segment}`,
        failedPath: segment,
      });
    }
    trusted = segment;
  }
  return trusted;
}

function validateRealSegment(targetPath: string, resolvedDeps: ResolvedDeps): void {
  const fileStat = readLstat(targetPath, resolvedDeps.fs);
  if (!fileStat) {
    throw new AgentStorePathError({
      code: "not_directory",
      message: `Trusted directory does not exist: ${targetPath}`,
      failedPath: targetPath,
    });
  }
  validateDirectoryStat(targetPath, fileStat);
}

function createRealSegment(targetPath: string, resolvedDeps: ResolvedDeps): void {
  let fileStat = readLstat(targetPath, resolvedDeps.fs);
  if (!fileStat) {
    try {
      resolvedDeps.fs.mkdirSync(targetPath, { mode: SECURE_DIRECTORY_MODE });
    } catch (failure) {
      if (!hasErrnoCode(failure) || failure.code !== "EEXIST") throw failure;
    }
    fileStat = readLstat(targetPath, resolvedDeps.fs);
    if (!fileStat) {
      throw new AgentStorePathError({
        code: "not_directory",
        message: `Failed to create directory: ${targetPath}`,
        failedPath: targetPath,
      });
    }
  }
  validateDirectoryStat(targetPath, fileStat);
}

function splitPathChain(targetPath: string, pathApi: typeof path): string[] {
  const rootPrefix = pathApi.parse(targetPath).root;
  const remainder = targetPath.slice(rootPrefix.length);
  const nameParts = remainder.split(/[\\/]+/).filter(Boolean);
  const pathChain: string[] = [];
  let currentDirectory = rootPrefix;
  if (rootPrefix) pathChain.push(rootPrefix);
  for (const part of nameParts) {
    currentDirectory = currentDirectory === rootPrefix ? pathApi.join(rootPrefix, part) : pathApi.join(currentDirectory, part);
    pathChain.push(currentDirectory);
  }
  return pathChain;
}

function readLstat(targetPath: string, fileSystem: PathFileSystem): fs.Stats | undefined {
  try {
    return fileSystem.lstatSync(targetPath);
  } catch (failure) {
    if (hasErrnoCode(failure) && failure.code === "ENOENT") return undefined;
    throw failure;
  }
}

function hasErrnoCode(failure: unknown): failure is NodeJS.ErrnoException {
  return failure instanceof Error && typeof (failure as NodeJS.ErrnoException).code === "string";
}
