/**
 * Where a plugin came from.
 *
 * A plugin is identified by its source and by whatever that source needs to name it: the ones the platform publishes
 * carry a database id, and the ones a user or an extension brought carry whatever their source knows. The id is what
 * the sources that have one are asked for, and the ones that do not are told apart by their source alone.
 */
export type PluginIdentifier =
  | { source: "cursor-first-party" | "cursor-third-party"; sourceInfo: { pluginDbId: string } }
  | { source: "claude-plugin" | "user-local" | "extension"; sourceInfo?: unknown };
export function getPluginDbId(identifier: PluginIdentifier): string | undefined {
  switch (identifier.source) { case "cursor-first-party": case "cursor-third-party": return identifier.sourceInfo.pluginDbId; default: return undefined; }
}
