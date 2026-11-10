export interface SessionDirectoryEntry {
  readonly name: string;
  isDirectory(): boolean;
}

/** The agent directories a session root owns, sorted so discovery does not depend on filesystem order. */
export function agentDirectoryIdsFrom(entries: readonly SessionDirectoryEntry[]): string[] {
  return entries.filter((entry) => entry.isDirectory()).map((entry) => entry.name).sort();
}
