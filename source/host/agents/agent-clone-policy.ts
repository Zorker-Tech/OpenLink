import { existsSync, readdirSync } from "node:fs"
import { join } from "node:path"

export const STORE_FILENAME = "store.db"
export const AUTOMATION_CONFIG_FILENAME = "automation.json"

export function listAgentAutomationConfigFiles(automationsDir: string): Array<{
  readonly folderName: string
  readonly configPath: string
}> {
  try {
    return readdirSync(automationsDir, { withFileTypes: true })
      .filter(entry => entry.isDirectory())
      .map(entry => ({
        folderName: entry.name,
        configPath: join(automationsDir, entry.name, AUTOMATION_CONFIG_FILENAME),
      }))
      .filter(entry => existsSync(entry.configPath))
  } catch {
    return []
  }
}

export function cloneAgentDisplayName(name: string): string {
  const cleanName = name.trim()
  return cleanName.length > 0 ? cleanName + " copy" : "copy"
}
