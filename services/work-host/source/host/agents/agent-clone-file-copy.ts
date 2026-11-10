import { copyFileSync, existsSync, mkdirSync } from "node:fs"
import { join } from "node:path"
import { agentWorkflowStatePath } from "./agent-workflow-enablement.ts"
import { listConventionalAvatarFilenames, resolveDerivedAvatarFilename } from "./agent-avatar.ts"
import { getSlateProfilePath, readLegacyProfileAvatarField, readSlateProfileFile, writeSlateProfileFile } from "./agent-profile.ts"
import { getSlateSettingsPath, writeAgentSettings } from "./settings-file.ts"
import { AUTOMATION_CONFIG_FILENAME, listAgentAutomationConfigFiles } from "./agent-clone-policy.ts"
import type { AgentCloneAdapters } from "./agent-clone-contracts.ts"

function copyIfPresent(source: string, target: string): void {
  if (existsSync(source)) copyFileSync(source, target)
}

function copyProfile(sourceDir: string, targetDir: string, cloneName: string): void {
  const current = readSlateProfileFile(getSlateProfilePath(sourceDir))
  writeSlateProfileFile(getSlateProfilePath(targetDir), {
    name: cloneName,
    description: current?.description ?? "",
    title: current?.title ?? "",
    avatarShape: current?.avatarShape ?? "",
    avatarColor: current?.avatarColor ?? "",
  })
}

function copySettings(sourceDir: string, targetDir: string): void {
  const target = getSlateSettingsPath(targetDir)
  copyIfPresent(getSlateSettingsPath(sourceDir), target)
  writeAgentSettings(target, { hiddenFromSidebar: false })
}

function copyWorkflowState(sourceDir: string, targetDir: string): void {
  copyIfPresent(agentWorkflowStatePath(sourceDir), agentWorkflowStatePath(targetDir))
}

function copyAvatarFiles(sourceDir: string, targetDir: string): void {
  resolveDerivedAvatarFilename(sourceDir, readLegacyProfileAvatarField(getSlateProfilePath(sourceDir)))
  for (const filename of listConventionalAvatarFilenames(sourceDir)) {
    copyFileSync(join(sourceDir, filename), join(targetDir, filename))
  }
}

function copyAutomationFiles(sourceDir: string, targetDir: string, adapters: AgentCloneAdapters): void {
  for (const config of listAgentAutomationConfigFiles(adapters.getAutomationsDir(sourceDir))) {
    const destination = join(adapters.getAutomationsDir(targetDir), config.folderName)
    mkdirSync(destination, { recursive: true })
    copyFileSync(config.configPath, join(destination, AUTOMATION_CONFIG_FILENAME))
  }
}

export function copyAgentCompanionFiles(
  sourceDir: string,
  targetDir: string,
  cloneName: string,
  adapters: AgentCloneAdapters,
): void {
  copyProfile(sourceDir, targetDir, cloneName)
  copySettings(sourceDir, targetDir)
  copyWorkflowState(sourceDir, targetDir)
  copyAvatarFiles(sourceDir, targetDir)
  copyAutomationFiles(sourceDir, targetDir, adapters)
}
