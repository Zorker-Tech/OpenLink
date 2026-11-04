import { existsSync } from "node:fs"
import { dirname } from "node:path"

import { getSlateProfilePath, writeSlateProfileFile } from "../../agents/agent-profile.ts"
import { getSlateSettingsPath, writeAgentSettings } from "../../agents/settings-file.ts"

interface RecoverableProfileDatabase {
  get(key: string): unknown
  getSlateProfile?(): { description?: string }
}

/** Restores the lightweight profile document when a recovered agent directory has lost it. */
export function ensureAgentProfileDocument(databasePath: string, database: RecoverableProfileDatabase): string {
  const profilePath = getSlateProfilePath(dirname(databasePath))
  if (existsSync(profilePath)) return profilePath

  const name = String(database.get("name") || "Slate").trim() || "Slate"
  const description = database.getSlateProfile?.().description?.trim() ?? ""
  writeSlateProfileFile(profilePath, { name, description, title: "", avatarShape: "", avatarColor: "" })
  return profilePath
}

/** Creates the default settings document if recovery left no file beside the database. */
export function ensureAgentSettingsDocument(databasePath: string): string {
  const settingsPath = getSlateSettingsPath(dirname(databasePath))
  if (!existsSync(settingsPath)) writeAgentSettings(settingsPath, {})
  return settingsPath
}
