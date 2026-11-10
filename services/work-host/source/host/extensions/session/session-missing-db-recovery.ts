import { existsSync } from "node:fs"
import { dirname } from "node:path"
import { getSlateProfilePath } from "../../agents/agent-profile.ts"
import { agentHasDurableFootprint, buildSummary } from "./session-summaries.ts"
import { statIfExists } from "./session-paths.ts"
import type { MissingDbRecoveryInput, SessionRecoveryHost } from "./session-mutations-contracts.ts"

export async function recoverDurableSession(
  host: SessionRecoveryHost,
  input: MissingDbRecoveryInput,
) {
  if (host.isAgentBeingDeleted(input.dirName)) return null

  const agentDirectory = dirname(input.dbPath)
  const profileExists = existsSync(getSlateProfilePath(agentDirectory))
  const hasDurableContent = profileExists
    || await agentHasDurableFootprint(agentDirectory, (directory) => host.memory.agentHasContent(directory))
  if (!hasDurableContent || host.isAgentBeingDeleted(input.dirName)) return null

  let databaseStats
  if (host.hasLiveDbHandle?.(input.dbPath) !== true) {
    host.reseedMinimalStoreDbIfMissing(input.dbPath)
    databaseStats = await statIfExists(input.dbPath)
  }
  const summaryStats = databaseStats == null ? undefined : { mtimeMs: Number(databaseStats.mtimeMs) }

  return buildSummary({
    extras: null,
    dbPath: input.dbPath,
    dirName: input.dirName,
    ...(summaryStats === undefined ? {} : { dbStats: summaryStats }),
    ...(input.activeAgentId == null ? {} : { activeAgentId: input.activeAgentId }),
    includeBlank: true,
    agentHasMemory: (directory) => host.memory.agentHasContent(directory),
  })
}
