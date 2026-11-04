import { copyFileSync, existsSync, mkdirSync, rmSync } from "node:fs"
import { join } from "node:path"
import { copyAgentCompanionFiles } from "./agent-clone-file-copy.ts"
import type { AgentCloneAdapters } from "./agent-clone-contracts.ts"
import { STORE_FILENAME } from "./agent-clone-policy.ts"

export {
  AUTOMATION_CONFIG_FILENAME,
  cloneAgentDisplayName,
  listAgentAutomationConfigFiles,
  STORE_FILENAME,
} from "./agent-clone-policy.ts"
export type { AgentCloneAdapters } from "./agent-clone-contracts.ts"

export class SlateAgentCloneError extends Error {
  override name = "SlateAgentCloneError"
}

export function cloneAgentDir(
  sourceDir: string,
  targetDir: string,
  newAgentId: string,
  cloneName: string,
  adapters: AgentCloneAdapters,
): void {
  mkdirSync(targetDir, { recursive: true })
  try {
    const sourceStorePath = join(sourceDir, STORE_FILENAME)
    if (!existsSync(sourceStorePath)) {
      throw new SlateAgentCloneError("This agent's data is missing and can't be duplicated.")
    }
    adapters.checkpointStore(sourceStorePath)
    copyFileSync(sourceStorePath, join(targetDir, STORE_FILENAME))
    copyAgentCompanionFiles(sourceDir, targetDir, cloneName, adapters)
    adapters.rewriteIdentity(targetDir, newAgentId, false)
  } catch (error) {
    rmSync(targetDir, { recursive: true, force: true })
    throw error
  }
}
