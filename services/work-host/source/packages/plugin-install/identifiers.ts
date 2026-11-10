/**
 * Where a plugin came from.
 *
 * A plugin is identified by its source and by whatever that source needs to name it: the ones the platform publishes
 * carry a database id, and the ones a user or an extension brought carry whatever their source knows. The id is what
 * the sources that have one are asked for, and the ones that do not are told apart by their source alone.
 */
export type PluginIdentifier =
  | { source: "first-party" | "third-party"; sourceInfo: { pluginDbId: string } }
  | { source: "slate-plugin" | "user-local" | "extension"; sourceInfo?: unknown };

/** The database id a plugin's source carries, or undefined for a source that has none. */
export function getPluginDbId(plugin: PluginIdentifier): string | undefined {
  if (plugin.source === "first-party" || plugin.source === "third-party") return plugin.sourceInfo.pluginDbId;
  return undefined;
}
