/**
 * Where the tool definitions of MCP servers are kept on disk, and how a tool is named in them.
 *
 * A server's tools are described by files, and the model is expected to read them before calling a tool — so the layout of those files is a contract rather than a detail: each server gets a directory, each tool a file under it. The name of the tool is inside the file rather than in its name, because a tool's own name is what the server answers to, and a filename has to survive a filesystem. A file that does not parse yields no name instead of an error, since a broken definition is the server's problem to report, not the reader's to crash on.
 */

export const MCP_DISK_CATALOG_MCPS_DIR = "mcps";
export const MCP_DISK_CATALOG_TOOLS_DIR = "tools";

/** The field names a stored definition may carry a tool's name in, in the order they are read. */
const TOOL_NAME_FIELDS = ["name", "toolName"] as const;

/** A text that says something, or nothing when the field is absent or another type. */
function nameText(value: unknown): string | undefined {
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

export function parseMcpToolNameFromDiskDefinitionJson(jsonText: string): string | undefined {
  let parsed: unknown;
  try {
    parsed = JSON.parse(jsonText);
  } catch {
    return undefined;
  }
  if (parsed === null || typeof parsed !== "object") return undefined;
  const record = parsed as Record<string, unknown>;
  for (const field of TOOL_NAME_FIELDS) {
    const name = nameText(record[field]);
    if (name !== undefined) return name;
  }
  return undefined;
}
