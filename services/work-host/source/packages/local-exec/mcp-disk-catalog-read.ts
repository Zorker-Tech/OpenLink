/** Read the names in a project's on-disk MCP tool catalog. */
import { readdir, readFile } from "node:fs/promises"
import { join } from "node:path"
import {
  MCP_DISK_CATALOG_MCPS_DIR,
  MCP_DISK_CATALOG_TOOLS_DIR,
  parseMcpToolNameFromDiskDefinitionJson,
} from "../agent-exec/mcp-disk-catalog.ts"
import { sanitizeServerName } from "./mcp.ts"

interface ProjectToolCatalog {
  readonly toolNames: string[]
  readonly toolsDirExists: boolean
}

function toolDefinitionsPath(projectDir: string, serverIdentifier: string): string {
  return join(
    projectDir,
    MCP_DISK_CATALOG_MCPS_DIR,
    sanitizeServerName(serverIdentifier),
    MCP_DISK_CATALOG_TOOLS_DIR,
  )
}

async function listDefinitionFiles(directory: string): Promise<string[] | null> {
  try {
    return await readdir(directory)
  } catch (error) {
    if ((error as { readonly code?: unknown } | null | undefined)?.code === "ENOENT") return null
    throw error
  }
}

async function nameFromDefinition(directory: string, fileName: string): Promise<string | undefined> {
  if (!fileName.endsWith(".json")) return undefined
  try {
    return parseMcpToolNameFromDiskDefinitionJson(await readFile(join(directory, fileName), "utf8"))
  } catch {
    return undefined
  }
}

function sortedUniqueNames(names: readonly (string | undefined)[]): string[] {
  const unique = new Set<string>()
  for (const name of names) {
    if (name) unique.add(name)
  }
  return [...unique].sort((left, right) => left.localeCompare(right))
}

export async function readMcpDiskCatalogToolNamesForProjectDir(
  projectDir: string,
  serverIdentifier: string,
): Promise<ProjectToolCatalog> {
  const directory = toolDefinitionsPath(projectDir, serverIdentifier)
  const files = await listDefinitionFiles(directory)
  if (files === null) return { toolNames: [], toolsDirExists: false }

  const candidates = await Promise.all(files.map(fileName => nameFromDefinition(directory, fileName)))
  return { toolNames: sortedUniqueNames(candidates), toolsDirExists: true }
}
