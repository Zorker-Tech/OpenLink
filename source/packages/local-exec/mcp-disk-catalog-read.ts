/**
 * The tool names a project's MCP catalog has on disk.
 *
 * The catalog keeps one definition file per tool, per server, so the names are read back from the files rather than
 * from a list that could drift from them: the entries that are not definitions are skipped, the names are
 * de-duplicated and sorted, and a catalog that was never written is an empty one rather than an error.
 */
import { readdir, readFile } from "node:fs/promises";
import path from "node:path";
import { MCP_DISK_CATALOG_MCPS_DIR, MCP_DISK_CATALOG_TOOLS_DIR, parseMcpToolNameFromDiskDefinitionJson } from "../agent-exec/mcp-disk-catalog.ts";
import { sanitizeServerName } from "./mcp.ts";

export async function readMcpDiskCatalogToolNamesForProjectDir(projectDir: string, serverIdentifier: string): Promise<{ toolNames: string[]; toolsDirExists: boolean }> {
  const toolsDir = path.join(projectDir, MCP_DISK_CATALOG_MCPS_DIR, sanitizeServerName(serverIdentifier), MCP_DISK_CATALOG_TOOLS_DIR);
  let entries: string[];
  try { entries = await readdir(toolsDir); }
  catch (error) {
    if ((error as { code?: unknown } | null | undefined)?.code === "ENOENT") return { toolNames: [], toolsDirExists: false };
    throw error;
  }
  const names = await Promise.all(entries.map(async (entryName) => {
    if (!entryName.endsWith(".json")) return undefined;
    try { return parseMcpToolNameFromDiskDefinitionJson(await readFile(path.join(toolsDir, entryName), "utf8")); }
    catch { return undefined; }
  }));
  return { toolNames: Array.from(new Set(names.filter((name): name is string => Boolean(name)))).sort((left, right) => left.localeCompare(right)), toolsDirExists: true };
}
