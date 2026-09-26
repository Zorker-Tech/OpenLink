/**
 * Where a host keeps its state on this machine.
 *
 * The directories are the platform's own, under the user's home, and a path is checked to be inside them before it is
 * written; linking one directory to another is done atomically, so a reader never sees it half linked.
 */
import { lstat, readlink, rm, symlink } from "node:fs/promises";
import { homedir } from "node:os";
import { isAbsolute, join, relative, resolve } from "node:path";

import { getSlateVariant } from "../shared/node/slate-variant.ts";
import { isPathWithin } from "../shared/node/paths.ts";
import { findSystemErrno } from "../shared/system-errno.ts";

export const SLATE_DATA_ROOT_ENV = "SLATE_DATA_ROOT";
export const SLATE_PRODUCTION_DATA_DIRNAME = ".slate";
export const SLATE_USER_DATA_DIR_ENV = "SLATE_USER_DATA_DIR";
export const SLATE_DATA_DIRNAME = "slate-data";
export const USER_DATA_DIR_FLAG = "--user-data-dir";
export const SLATE_BOX_HOME_DIR = "/home/box";
export const SLATE_BOX_DATA_ROOT = `${SLATE_BOX_HOME_DIR}/${SLATE_DATA_DIRNAME}`;
export const SLATE_BOX_MODEL_VISIBLE_DATA_ROOT = `${SLATE_BOX_HOME_DIR}/agent-data`;

export function toModelVisiblePath(path: string): string {
  if (!isPathWithin(SLATE_BOX_DATA_ROOT, path, { isInclusive: true })) return path;
  return join(SLATE_BOX_MODEL_VISIBLE_DATA_ROOT, relative(SLATE_BOX_DATA_ROOT, path));
}

async function lstatIfExists(path: string) {
  try { return await lstat(path); }
  catch (error) { if (findSystemErrno(error) !== "ENOENT") throw error; return null; }
}

export async function ensureDataRootAlias(args: { readonly dataRoot: string; readonly aliasPath: string }): Promise<void> {
  const existing = await lstatIfExists(args.aliasPath);
  if (existing != null) {
    if (!existing.isSymbolicLink()) return;
    if (await readlink(args.aliasPath) === args.dataRoot) return;
    await rm(args.aliasPath);
  }
  await symlink(args.dataRoot, args.aliasPath);
}

export function readUserDataDirArg(argv: readonly string[]): string | null {
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === undefined) continue;
    if (arg === USER_DATA_DIR_FLAG) {
      const next = argv[i + 1];
      return next != null && !next.startsWith("--") ? next : null;
    }
    const prefix = `${USER_DATA_DIR_FLAG}=`;
    if (arg.startsWith(prefix)) return arg.slice(prefix.length);
  }
  return null;
}

export function resolveSlateUserDataDir(argv: readonly string[] = [], env: NodeJS.ProcessEnv = process.env, cwd = process.cwd()): string | null {
  const raw = readUserDataDirArg(argv) ?? env[SLATE_USER_DATA_DIR_ENV];
  const trimmed = raw?.trim();
  if (trimmed == null || trimmed.length === 0) return null;
  return isAbsolute(trimmed) ? trimmed : resolve(cwd, trimmed);
}

export function getSlateProductionRootDir(homeDir = homedir()): string { return join(homeDir, SLATE_PRODUCTION_DATA_DIRNAME); }

export function resolveSlateDataRootOverride(env: NodeJS.ProcessEnv = process.env): string | null {
  const override = env[SLATE_DATA_ROOT_ENV]?.trim();
  return override != null && override.length > 0 && isAbsolute(override) ? override : null;
}

export function getSlateRootDir(homeDir = homedir()): string {
  const override = resolveSlateDataRootOverride();
  if (override != null) return override;
  const userDataDir = resolveSlateUserDataDir([], process.env);
  if (userDataDir != null) return join(userDataDir, SLATE_DATA_DIRNAME);
  const variant = getSlateVariant();
  return variant === "slate" ? getSlateProductionRootDir(homeDir) : join(homeDir, ".slate", variant);
}

export function reanchorSlatePath(storedPath: string): string {
  const root = getSlateRootDir();
  if (isPathWithin(root, storedPath, { isInclusive: true })) return storedPath;
  const match = /[/\\]\.slate(?:-[^/\\]+)?[/\\](.+)$/.exec(storedPath);
  if (match?.[1] == null) return storedPath;
  const segments = match[1].split(/[/\\]+/);
  if (segments.some((segment) => segment === "." || segment === "..")) return storedPath;
  return join(root, ...segments);
}

export function getGatewayDiscoveryPath(homeDir = homedir()): string { return join(getSlateRootDir(homeDir), "gateway.json"); }
export function getHostLockPath(homeDir = homedir()): string { return join(getSlateRootDir(homeDir), "host.lock"); }
export function getHostSecretsPath(homeDir = homedir()): string { return join(getSlateRootDir(homeDir), "host-secrets.json"); }
export function getHostUpgradeMarkerPath(homeDir = homedir()): string { return join(getSlateRootDir(homeDir), ".slate-host-upgrade.json"); }
export function getHostCrashMarkerPath(homeDir = homedir()): string { return join(getSlateRootDir(homeDir), ".slate-host-crash.json"); }
