/**
 * Where the tool definitions of MCP servers are kept on disk, and how a tool is named in them.
 *
 * A server's tools are described by files, and the model is expected to read them before calling a tool — so the layout of those files is a contract rather than a detail: each server gets a directory, each tool a file under it. The name of the tool is inside the file rather than in its name, because a tool's own name is what the server answers to, and a filename has to survive a filesystem. A file that does not parse yields no name instead of an error, since a broken definition is the server's problem to report, not the reader's to crash on.
 */

export const MCP_DISK_CATALOG_MCPS_DIR = "mcps";
export const MCP_DISK_CATALOG_TOOLS_DIR = "tools";
export function parseMcpToolNameFromDiskDefinitionJson(jsonText: string): string | undefined {
  try {
    const parsed: unknown = JSON.parse(jsonText);
    if (parsed === null || typeof parsed !== "object") return undefined;
    const record = parsed as Record<string, unknown>;
    if (typeof record.name === "string" && record.name.length > 0) return record.name;
    if (typeof record.toolName === "string" && record.toolName.length > 0) return record.toolName;
    return undefined;
  } catch { return undefined; }
}
