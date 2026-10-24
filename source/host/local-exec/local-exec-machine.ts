/**
 * What the local-exec daemon may touch on this machine.
 *
 * A path is resolved through the nearest existing directory before it is compared with the roots the daemon is allowed
 * to reach, so a symbolic link cannot be used to step outside them; a path that is outside is refused with the reason.
 */
import { stat } from "node:fs/promises";
import { homedir } from "node:os";
import { isAbsolute, relative, resolve } from "node:path";

import { realpathNearestExisting } from "../../shared/node/paths.ts";

export class SlateLocalExecPathError extends Error {}

async function inspectPath(pathname: string) {
  try {
    return await stat(pathname);
  } catch {
    return undefined;
  }
}

export async function regularFileSizeBytes(path: string): Promise<number | undefined> {
  const entry = await inspectPath(path);
  if (entry === undefined || !entry.isFile()) return undefined;
  return entry.size;
}

export function resolveLocalExecRoot(env: NodeJS.ProcessEnv = process.env): string {
  const primaryRoot = env.SLATE_LOCAL_EXEC_ROOT?.trim();
  if (primaryRoot) return primaryRoot;
  const projectRoot = env.SLATE_AGENT_PROJECT_DIR?.trim();
  return projectRoot || homedir();
}

async function isDirectory(pathname: string): Promise<boolean> {
  const entry = await inspectPath(pathname);
  return entry !== undefined && entry.isDirectory();
}

function absoluteFrom(root: string, candidate: string): string {
  if (isAbsolute(candidate)) return resolve(candidate);
  return resolve(root, candidate);
}

export async function resolveShellWorkingDirectory(args: { readonly root: string; readonly requested: string }): Promise<{ workingDirectory: string; fellBackToRoot: boolean }> {
  const requested = args.requested.trim();
  if (requested.length === 0) return { workingDirectory: requested, fellBackToRoot: false };
  const targetDirectory = absoluteFrom(args.root, requested);
  if (await isDirectory(targetDirectory)) {
    return { workingDirectory: targetDirectory, fellBackToRoot: false };
  }
  return { workingDirectory: args.root, fellBackToRoot: true };
}

export function missingWorkingDirectoryNotice(args: { readonly requested: string; readonly root: string }): string {
  return `working directory ${args.requested} does not exist on this machine; running in ${args.root} instead\n`;
}

export function escapesRoot(base: string, target: string): boolean {
  const pathFromBase = relative(base, target);
  if (pathFromBase === "") return false;
  return pathFromBase.startsWith("..") || isAbsolute(pathFromBase);
}

export async function containPath(args: { readonly root: string; readonly path: string }): Promise<string> {
  const resolved = absoluteFrom(args.root, args.path);
  if (escapesRoot(args.root, resolved)) {
    throw new SlateLocalExecPathError(`Path is outside the allowed local-exec root and was refused: ${args.path}`);
  }
  let realRoot: string;
  try { realRoot = await realpathNearestExisting(args.root); }
  catch { return resolved; }
  const realResolved = await realpathNearestExisting(resolved);
  if (escapesRoot(realRoot, realResolved)) {
    throw new SlateLocalExecPathError(`Path resolves through a symlink to outside the allowed local-exec root and was refused: ${args.path}`);
  }
  return resolved;
}

/**
 * The original manager wiring depends on the recovered workspace local-exec
 * package. Keeping that dependency explicit prevents a reduced substitute from
 * being mistaken for the shipped executor while the package runtime is rebuilt.
 */
export interface LocalExecManagerRuntime<Manager> {
  build(root: string, maxFileBytes: number, guards: {
    readonly containPath: typeof containPath;
    readonly regularFileSizeBytes: typeof regularFileSizeBytes;
    readonly resolveShellWorkingDirectory: typeof resolveShellWorkingDirectory;
    readonly missingWorkingDirectoryNotice: typeof missingWorkingDirectoryNotice;
  }): Manager;
}

export function buildLocalExecManager<Manager>(root: string, maxFileBytes: number, runtime: LocalExecManagerRuntime<Manager>): Manager {
  return runtime.build(root, maxFileBytes, { containPath, regularFileSizeBytes, resolveShellWorkingDirectory, missingWorkingDirectoryNotice });
}

