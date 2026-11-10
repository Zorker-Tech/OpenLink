/**
 * Which transcript entries belong to a thread.
 *
 * An entry may reply to another, and a reply that is part of a branch belongs to that branch rather than to the main
 * transcript; a reply that stands on its own does not. The branch's root is found by walking the replies up, with a
 * cycle treated as no root rather than as an endless walk.
 */
export interface ThreadEntry {
  readonly id: string;
  readonly replyTo?: string;
  readonly [key: string]: unknown;
}

/** What an entry replies to, if it says. */
function replyToOf(entry: ThreadEntry): string | undefined {
  return "replyTo" in entry ? entry.replyTo : undefined;
}

/**
 * The entry a branch hangs from, and nothing when it does not hang from one.
 *
 * The walk stops at the first entry that is not in the map, which is then the root itself — a reply to something this
 * build does not hold is a branch of its own, not an orphan.
 */
function resolveBranchRoot(entry: ThreadEntry, branchedById: ReadonlyMap<string, ThreadEntry>): string | undefined {
  const walked = new Set([entry.id]);
  for (let current = entry; ; ) {
    const parentId = replyToOf(current);
    if (parentId === undefined) return undefined;
    const parent = branchedById.get(parentId);
    if (parent === undefined) return parentId;
    if (walked.has(parentId)) return undefined;
    walked.add(parentId);
    current = parent;
  }
}

/** The entries by their own id, which every walk below is read against. */
function indexById<T extends ThreadEntry>(branched: readonly T[]): Map<string, ThreadEntry> {
  return new Map(branched.map((entry) => [entry.id, entry]));
}

/** How many replies each branch root has, by the root's id. */
export function replyCountByBranch(branched: readonly ThreadEntry[]): Map<string, number> {
  const byId = indexById(branched);
  const counts = new Map<string, number>();
  for (const entry of branched) {
    const root = resolveBranchRoot(entry, byId);
    if (root === undefined) continue;
    counts.set(root, (counts.get(root) ?? 0) + 1);
  }
  return counts;
}

/** Every entry in the branch this root hangs, in the order the transcript holds them. */
export function branchEntries<T extends ThreadEntry>(rootId: string, branched: readonly T[]): T[] {
  const byId = indexById(branched);
  return branched.filter((entry) => resolveBranchRoot(entry, byId) === rootId);
}
