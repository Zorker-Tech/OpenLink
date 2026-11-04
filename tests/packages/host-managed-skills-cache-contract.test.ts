import assert from "node:assert/strict"
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { after, test } from "node:test"

import {
  getManagedSkillFilePath,
  getManagedSkillsCachePath,
  getManagedSkillsDir,
  isManagedSkill,
  MANAGED_SKILLS_CACHE_FILENAME,
  materializeManagedSkillFiles,
  readManagedSkillsCache,
  writeManagedSkillsCache,
} from "../../source/host/extensions/managed-setup/managed-skills-cache.ts"
import { AGENT_READABLE_SKILL_DIR_MODE, AGENT_READABLE_SKILL_FILE_MODE } from "../../source/shared/workflow-model.ts"

const roots: string[] = []
after(() => { for (const root of roots) rmSync(root, { recursive: true, force: true }) })
const freshRoot = () => { const root = mkdtempSync(join(tmpdir(), "slate-managed-skills-")); roots.push(root); return root }

const skill = (id: string, body: string) => ({ id, name: `Skill ${id}`, description: "", body })

test("cache locations and skill validation are stable", () => {
  const root = freshRoot()
  const cacheDir = getManagedSkillsDir(root)
  assert.equal(cacheDir, join(root, "managed-skills"))
  assert.equal(getManagedSkillsCachePath(cacheDir), join(cacheDir, MANAGED_SKILLS_CACHE_FILENAME))
  assert.equal(getManagedSkillFilePath(cacheDir, "skill-a"), join(cacheDir, "skills", "skill-a", "SKILL.md"))
  assert.equal(isManagedSkill({ id: "skill-a", name: "", description: "", body: "Body" }), true)
  assert.equal(isManagedSkill({ id: "", name: "Skill", description: "", body: "Body" }), false)
  assert.equal(isManagedSkill({ id: "skill-a", name: "Skill", description: "", body: "" }), false)
  assert.equal(isManagedSkill(null), false)
})

test("the reader returns a complete cache or nothing when any record is malformed", () => {
  const cacheDir = getManagedSkillsDir(freshRoot())
  assert.equal(readManagedSkillsCache(cacheDir), null)
  mkdirSync(cacheDir, { recursive: true })
  const cachePath = getManagedSkillsCachePath(cacheDir)

  writeFileSync(cachePath, "not-json")
  assert.equal(readManagedSkillsCache(cacheDir), null)
  writeFileSync(cachePath, JSON.stringify({ fetchedAt: "42", skills: [skill("a", "body")] }))
  assert.equal(readManagedSkillsCache(cacheDir), null)
  writeFileSync(cachePath, JSON.stringify({ fetchedAt: 42, skills: [skill("a", "body"), skill("b", "")] }))
  assert.equal(readManagedSkillsCache(cacheDir), null)
  writeFileSync(cachePath, JSON.stringify({ fetchedAt: 42, skills: [skill("a", "body")] }))
  assert.deepEqual(readManagedSkillsCache(cacheDir), { fetchedAt: 42, skills: [skill("a", "body")] })
})

test("writing a cache materializes private files and removes skills absent from the new snapshot", () => {
  const cacheDir = getManagedSkillsDir(freshRoot())
  const initial = [skill("reviewer", "Review the diff."), skill("writer", "Write the summary.")]
  writeManagedSkillsCache(cacheDir, initial, () => 10)
  const loaded = readManagedSkillsCache(cacheDir)
  assert.deepEqual(loaded, { fetchedAt: 10, skills: initial })
  assert.deepEqual(readdirSync(join(cacheDir, "skills")).sort(), ["reviewer", "writer"])
  assert.match(readFileSync(getManagedSkillFilePath(cacheDir, "reviewer"), "utf8"), /Review the diff\./)
  assert.equal(statSync(cacheDir).mode & 0o777, AGENT_READABLE_SKILL_DIR_MODE)
  assert.equal(statSync(join(cacheDir, "skills")).mode & 0o777, AGENT_READABLE_SKILL_DIR_MODE)
  assert.equal(statSync(getManagedSkillFilePath(cacheDir, "reviewer")).mode & 0o777, AGENT_READABLE_SKILL_FILE_MODE)
  assert.equal(existsSync(`${getManagedSkillsCachePath(cacheDir)}.tmp`), false)
  assert.equal(existsSync(`${getManagedSkillFilePath(cacheDir, "reviewer")}.tmp`), false)

  const orphan = join(cacheDir, "skills", "orphan")
  mkdirSync(orphan, { recursive: true })
  writeFileSync(join(orphan, "SKILL.md"), "old")
  materializeManagedSkillFiles(cacheDir, [skill("writer", "Updated body.")])
  assert.deepEqual(readdirSync(join(cacheDir, "skills")), ["writer"])
  assert.match(readFileSync(getManagedSkillFilePath(cacheDir, "writer"), "utf8"), /Updated body\./)
})
