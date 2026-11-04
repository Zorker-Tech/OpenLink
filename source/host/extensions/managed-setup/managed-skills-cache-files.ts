import { chmodSync, mkdirSync, readFileSync, readdirSync, renameSync, rmSync, writeFileSync } from "node:fs"
import { join } from "node:path"

import { AGENT_READABLE_SKILL_DIR_MODE, AGENT_READABLE_SKILL_FILE_MODE, serializeWorkflowFile } from "../../../shared/workflow-model.ts"
import { isManagedSkill, type ManagedSkill, type ManagedSkillsCache } from "./managed-skills-cache-contracts.ts"
import { getManagedSkillFilePath, getManagedSkillsCachePath } from "./managed-skills-cache-paths.ts"

function managedDirectory(path: string): void {
  mkdirSync(path, { recursive: true, mode: AGENT_READABLE_SKILL_DIR_MODE })
  chmodSync(path, AGENT_READABLE_SKILL_DIR_MODE)
}

function replacePrivateFile(path: string, body: string, mode: number): void {
  const stagingPath = `${path}.tmp`
  writeFileSync(stagingPath, body, { encoding: "utf8", mode })
  chmodSync(stagingPath, mode)
  renameSync(stagingPath, path)
}

export function readManagedSkillsCache(cacheDir: string): ManagedSkillsCache | null {
  try {
    const decoded = JSON.parse(readFileSync(getManagedSkillsCachePath(cacheDir), "utf8")) as Record<string, unknown>
    if (typeof decoded.fetchedAt !== "number" || !Number.isFinite(decoded.fetchedAt)) return null
    if (!Array.isArray(decoded.skills) || !decoded.skills.every(isManagedSkill)) return null
    return { fetchedAt: decoded.fetchedAt, skills: decoded.skills }
  } catch {
    return null
  }
}

export function writeManagedSkillsCache(cacheDir: string, skills: readonly ManagedSkill[], now: () => number = Date.now): void {
  managedDirectory(cacheDir)
  replacePrivateFile(getManagedSkillsCachePath(cacheDir), `${JSON.stringify({ fetchedAt: now(), skills }, null, 2)}\n`, AGENT_READABLE_SKILL_FILE_MODE)
  materializeManagedSkillFiles(cacheDir, skills)
}

export function materializeManagedSkillFiles(cacheDir: string, skills: readonly ManagedSkill[]): void {
  const root = join(cacheDir, "skills")
  managedDirectory(root)

  const retainedIds = new Set(skills.map(skill => skill.id))
  for (const entry of readdirSync(root, { withFileTypes: true })) {
    if (!retainedIds.has(entry.name)) rmSync(join(root, entry.name), { recursive: true, force: true })
  }

  for (const skill of skills) {
    const folder = join(root, skill.id)
    managedDirectory(folder)
    const document = serializeWorkflowFile({ name: skill.name, description: skill.description, body: skill.body, trigger: null })
    replacePrivateFile(getManagedSkillFilePath(cacheDir, skill.id), document, AGENT_READABLE_SKILL_FILE_MODE)
  }
}
