import type { Dirent } from "node:fs";
import { readdir, statfs } from "node:fs/promises";
import { dirname, join, relative, sep } from "node:path";
import { findSystemErrno } from "../../../shared/system-errno.ts";
import { BoxStoreSyncError } from "./box-store-sync-error.ts";
import type { BoxStoreManifestEntry } from "./box-store-manifest-format.ts";
import type { FileOutcome, TransferSummary } from "./box-store-transfer-contracts.ts";

export const SNAPSHOT_OUT_LARGE_CONCURRENCY = 2;
export const BOX_STORE_SNAPSHOT_TMP_SUFFIX = ".box-store-snap-";

export type WalkNode =
  | { readonly kind: "file" | "symlink"; readonly absPath: string }
  | { readonly kind: "readdir-error" };

export async function readFreeDiskBytes(path: string): Promise<number | undefined> {
  let probePath = path;
  while (true) {
    try {
      const stats = await statfs(probePath);
      return Number(stats.bavail) * Number(stats.bsize);
    } catch {
      const parentPath = dirname(probePath);
      if (parentPath === probePath) return undefined;
      probePath = parentPath;
    }
  }
}

/** A glob's stars are path-aware; a match may also name a directory containing matching descendants. */
export function globToRegExp(glob: string): RegExp {
  let source = "";
  for (let cursor = 0; cursor < glob.length; cursor += 1) {
    const character = glob[cursor]!;
    if (character === "*") {
      if (glob[cursor + 1] === "*") {
        source += ".*";
        cursor += 1;
      } else {
        source += "[^/]*";
      }
      continue;
    }
    source += /[.+^${}()|[\]\\?]/.test(character) ? `\\${character}` : character;
  }
  return new RegExp(`^${source}(?:/.*)?$`);
}

export function tallyFileOutcome(summary: TransferSummary, outcome: FileOutcome, size: number): void {
  switch (outcome) {
    case "uploaded":
      summary.filesUploaded += 1;
      summary.bytesUploaded += size;
      return;
    case "unchanged":
      summary.skippedUnchanged += 1;
      return;
    case "oversize":
      summary.oversize += 1;
      return;
    case "metadata-error":
      summary.failures += 1;
      summary.metadataFailures += 1;
      return;
    case "error":
      summary.failures += 1;
  }
}

export function tallyMetadataFailure(summary: TransferSummary): void {
  summary.metadataFailures += 1;
  summary.failures += 1;
}

export function isSnapshotNodeRace(error: unknown): boolean {
  const code = findSystemErrno(error);
  return code === "ENOENT" || code === "ELOOP" || error instanceof BoxStoreSyncError;
}

export function classifyFileFailure(
  previous: BoxStoreManifestEntry | undefined,
  currentMode: number,
  ordinaryOutcome: "oversize" | "error",
): FileOutcome {
  const wasLink = previous?.kind === "symlink";
  const permissionsChanged = previous?.kind === "file" && previous.mode !== currentMode;
  return wasLink || permissionsChanged ? "metadata-error" : ordinaryOutcome;
}

function rootIsAncestor(parent: string, candidate: string): boolean {
  return parent !== candidate && candidate.startsWith(`${parent}/`);
}

export function dedupeNestedRoots(roots: readonly string[]): string[] {
  const distinctRoots = [...new Set(roots)];
  return distinctRoots.filter((candidate) => !distinctRoots.some((parent) => rootIsAncestor(parent, candidate)));
}

interface DirectoryWork {
  readonly type: "directory";
  readonly absPath: string;
}

interface EntryWork {
  readonly type: "entry";
  readonly absPath: string;
  readonly entry: Dirent;
}

/** Visits descendants depth-first in directory order, never traverses a symlink, and reports an unreadable directory. */
export async function* walkNodes(
  root: string,
  shouldSkipDir?: (relativeDirectory: string) => boolean,
): AsyncGenerator<WalkNode> {
  const pending: Array<DirectoryWork | EntryWork> = [{ type: "directory", absPath: root }];
  while (pending.length > 0) {
    const work = pending.pop()!;
    if (work.type === "directory") {
      let entries: Dirent[];
      try {
        entries = await readdir(work.absPath, { withFileTypes: true });
      } catch {
        yield { kind: "readdir-error" };
        continue;
      }
      for (let index = entries.length - 1; index >= 0; index -= 1) {
        const entry = entries[index]!;
        pending.push({ type: "entry", absPath: join(work.absPath, entry.name), entry });
      }
      continue;
    }

    if (work.entry.isSymbolicLink()) {
      yield { kind: "symlink", absPath: work.absPath };
      continue;
    }
    if (work.entry.isDirectory()) {
      const relativeDirectory = relative(root, work.absPath).split(sep).join("/");
      if (shouldSkipDir?.(relativeDirectory) === true) continue;
      pending.push({ type: "directory", absPath: work.absPath });
      continue;
    }
    if (work.entry.isFile()) yield { kind: "file", absPath: work.absPath };
  }
}
