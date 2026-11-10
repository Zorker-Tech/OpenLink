/** Remove credentials left beside MCP settings by older host releases. */
import { readdir, rm } from "node:fs/promises"
import { join } from "node:path"
import { findSystemErrno } from "../../system-errno.ts"

export const LEGACY_MCP_AUTH_FILENAME = "mcp-auth.json"

export type LegacyMcpAuthCleanupResult = {
  readonly outcome: "not_found" | "error" | "deleted"
  readonly removedCount: number
}

export function isLegacyMcpAuthFile(name: string): boolean {
  return name === LEGACY_MCP_AUTH_FILENAME || name.startsWith(`${LEGACY_MCP_AUTH_FILENAME}.`)
}

async function findLegacyCredentials(rootDirectory: string): Promise<string[] | null> {
  let entries: string[]
  try {
    entries = await readdir(rootDirectory)
  } catch (error) {
    if (findSystemErrno(error) === "ENOENT") return null
    throw error
  }
  return entries.filter(isLegacyMcpAuthFile)
}

async function removeLegacyCredentials(rootDirectory: string, names: readonly string[]): Promise<LegacyMcpAuthCleanupResult> {
  let removedCount = 0
  let failed = false
  for (const name of names) {
    try {
      await rm(join(rootDirectory, name), { force: true })
      removedCount += 1
    } catch {
      failed = true
    }
  }
  return { outcome: failed ? "error" : "deleted", removedCount }
}

export async function cleanupLegacyMcpAuthCredentials(rootDirectory: string): Promise<LegacyMcpAuthCleanupResult> {
  let names: string[] | null
  try {
    names = await findLegacyCredentials(rootDirectory)
  } catch {
    return { outcome: "error", removedCount: 0 }
  }
  if (names === null || names.length === 0) return { outcome: "not_found", removedCount: 0 }
  return removeLegacyCredentials(rootDirectory, names)
}
