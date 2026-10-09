/**
 * A flat listing, adapted to the directory that was asked for.
 *
 * The store can answer with everything it holds at once; what a caller asked for is one directory of it, so the files
 * under that directory are kept, the directories directly under it are named, and an entry whose path the store should
 * never have handed over is counted rather than passed on.
 */
import type { AgentStoreListFile, AgentStoreListing, AgentStoreTombstone } from "./bcs-transport.ts";
import { normalizeRelPath } from "./safe-paths.ts";

type FlatListArgs = {
  readonly files: readonly AgentStoreListFile[];
  readonly relPath: string;
  readonly tombstones?: readonly AgentStoreTombstone[];
  readonly listingComplete?: boolean;
};
type AdaptedFlatListing = Omit<AgentStoreListing, "tombstones" | "listingComplete"> & Partial<Pick<AgentStoreListing, "tombstones" | "listingComplete">>;

export function adaptFlatAgentStoreList(args: FlatListArgs & { readonly tombstones: readonly AgentStoreTombstone[]; readonly listingComplete: boolean }): AgentStoreListing;
export function adaptFlatAgentStoreList(args: FlatListArgs): AdaptedFlatListing;
export function adaptFlatAgentStoreList({ files, relPath, tombstones, listingComplete }: FlatListArgs): AdaptedFlatListing {
  const requestedRelPath = normalizeRequestedRelPath(relPath);
  const prefix = listDirPrefix(requestedRelPath);
  const subdirs = new Set<string>();
  const matchedFiles: AgentStoreListFile[] = [];
  let skippedUnsafeEntries = 0;
  for (const file of files) {
    let normalizedPath: string;
    try {
      normalizedPath = normalizeRelPath(file.relPath);
    } catch {
      // A path the store should never have handed over is counted, and nothing else is made of it.
      skippedUnsafeEntries += 1;
      continue;
    }
    collectSubdir({ prefix, relObjectPath: normalizedPath, subdirs });
    if (!normalizedPath.startsWith(prefix)) continue;
    matchedFiles.push({ ...file, relPath: normalizedPath });
  }
  return {
    files: matchedFiles.sort((left, right) => left.relPath.localeCompare(right.relPath)),
    subdirs: [...subdirs].sort(),
    ...(tombstones === undefined ? {} : { tombstones }),
    ...(listingComplete === undefined ? {} : { listingComplete }),
    skippedUnsafeEntries,
  };
}

/** The directory the caller asked for: the root stays the root, anything else is a path like any other. */
function normalizeRequestedRelPath(relPath: string): string {
  return relPath === "" ? "" : normalizeRelPath(relPath);
}

/** What every kept path has to start with, so that "notes" does not also match "notes-elsewhere". */
function listDirPrefix(requestedRelPath: string): string {
  return requestedRelPath.length === 0 ? "" : `${requestedRelPath.replace(/\/$/, "")}/`;
}

/** The directory directly under the requested one, when the file sits one level down. */
function collectSubdir({ prefix, relObjectPath, subdirs }: { readonly prefix: string; readonly relObjectPath: string; readonly subdirs: Set<string> }): void {
  if (!relObjectPath.startsWith(prefix)) return;
  const remaining = relObjectPath.slice(prefix.length);
  const firstSlash = remaining.indexOf("/");
  if (firstSlash > 0) subdirs.add(`${prefix}${remaining.slice(0, firstSlash)}`);
}
