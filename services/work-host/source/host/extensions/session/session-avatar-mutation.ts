import { mkdir, rm, writeFile } from "node:fs/promises"
import { dirname, join } from "node:path"
import {
  CANONICAL_AVATAR_FILENAME,
  invalidateAvatarDataUrlCache,
  listConventionalAvatarFilenames,
} from "../../agents/agent-avatar.ts"
import { buildSummary, loadAgentDbExtras } from "./session-summaries.ts"
import { statIfExists } from "./session-paths.ts"
import type { MutationDb, SessionMutationMemory } from "./session-mutations-contracts.ts"

export async function persistAvatarAndBuildSummary(
  host: { readonly memory: SessionMutationMemory },
  db: MutationDb,
  dbPath: string,
  agentId: string,
  pngBytes: Uint8Array | null,
  activeAgentId?: string,
) {
  const agentDirectory = dirname(dbPath)
  for (const filename of listConventionalAvatarFilenames(agentDirectory)) {
    await rm(join(agentDirectory, filename), { force: true })
  }

  if (pngBytes == null) {
    const profile = db.getSlateProfile()
    if (profile.avatarPath != null) {
      db.setSlateProfile({ description: profile.description, avatarPath: null })
    }
  } else {
    await mkdir(agentDirectory, { recursive: true })
    await writeFile(join(agentDirectory, CANONICAL_AVATAR_FILENAME), Buffer.from(pngBytes))
  }

  invalidateAvatarDataUrlCache(agentDirectory)
  const fileStats = await statIfExists(dbPath)
  const databaseStats = fileStats == null ? undefined : { mtimeMs: Number(fileStats.mtimeMs) }
  return buildSummary({
    extras: loadAgentDbExtras(db, dbPath, agentId, databaseStats),
    dbPath,
    dirName: agentId,
    ...(databaseStats === undefined ? {} : { dbStats: databaseStats }),
    ...(activeAgentId == null ? {} : { activeAgentId }),
    includeBlank: true,
    agentHasMemory: (directory) => host.memory.agentHasContent(directory),
  })
}
