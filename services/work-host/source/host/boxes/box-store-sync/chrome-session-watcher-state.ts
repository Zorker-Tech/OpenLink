import { join } from "node:path"

export type ReadSessionMtime = (path: string) => number | undefined

export function sessionDatabaseNameMatches(names: readonly string[], filename: string): boolean {
  return names.some((name) => filename.startsWith(name))
}

export function existingSessionMtimes(
  watchDir: string,
  names: readonly string[],
  readMtime: ReadSessionMtime,
): Map<string, number> {
  const found = new Map<string, number>()
  for (const name of names) {
    const mtime = readMtime(join(watchDir, name))
    if (mtime != null) found.set(name, mtime)
  }
  return found
}

export function advancedSessionMtimes(
  watchDir: string,
  names: readonly string[],
  previous: ReadonlyMap<string, number>,
  readMtime: ReadSessionMtime,
): { readonly changed: boolean; readonly updates: ReadonlyMap<string, number> } {
  const updates = new Map<string, number>()
  for (const name of names) {
    const current = readMtime(join(watchDir, name))
    if (current == null) continue
    const prior = previous.get(name)
    if (prior == null || current > prior) updates.set(name, current)
  }
  return { changed: updates.size > 0, updates }
}
