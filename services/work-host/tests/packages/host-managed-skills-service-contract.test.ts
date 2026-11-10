import assert from "node:assert/strict"
import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { test } from "node:test"

import { readManagedSkillsCache, writeManagedSkillsCache } from "../../source/host/extensions/managed-setup/managed-skills-cache.ts"
import { SlateManagedSkillsService } from "../../source/host/extensions/managed-setup/managed-skills-service.ts"
import type { FetchedManagedSkill } from "../../source/host/extensions/managed-setup/slate-managed-skills.ts"

const fetched = (id: string, body = "---\nname: Review\n---\nReview the changes.", enabled = true): FetchedManagedSkill => ({
  id,
  description: "reviewing changes",
  content: body,
  enabled,
})

function cacheWorld(fetch: () => Promise<readonly FetchedManagedSkill[]>) {
  const cacheDir = mkdtempSync(join(tmpdir(), "slate-managed-skills-service-"))
  const reports: unknown[] = []
  const service = new SlateManagedSkillsService({
    getCacheDir: () => cacheDir,
    fetch,
    report: (event) => reports.push(event),
  })
  return {
    cacheDir,
    reports,
    service,
    disposeFiles: () => rmSync(cacheDir, { recursive: true, force: true }),
  }
}

function waitForCurrentTurn(): Promise<void> {
  return new Promise((resolve) => setImmediate(resolve))
}

test("refresh stores only enabled, safe, nonempty managed skills and ensure checks the cache", async () => {
  let fetches = 0
  const world = cacheWorld(async () => {
    fetches += 1
    return [fetched("reviewer"), fetched("disabled", "---\nname: Hidden\n---\nbody", false), fetched("../escape"), fetched("empty", "   ")]
  })
  try {
    assert.equal(await world.service.ensureSkillIsCached("reviewer"), true)
    assert.equal(fetches, 1)
    assert.deepEqual(readManagedSkillsCache(world.cacheDir)?.skills.map(({ id, name }) => [id, name]), [["reviewer", "Review"]])
    assert.equal(await world.service.ensureSkillIsCached("reviewer"), true)
    assert.equal(fetches, 1)
    assert.equal(await world.service.ensureSkillIsCached("unknown"), false)
    assert.equal(fetches, 2)
  } finally {
    world.service.dispose()
    world.disposeFiles()
  }
})

test("concurrent refresh requests share one fetch and only the latest queued reason repeats", async () => {
  let releaseFirst!: (skills: readonly FetchedManagedSkill[]) => void
  let fetches = 0
  const world = cacheWorld(async () => {
    fetches += 1
    if (fetches === 1) return await new Promise((resolve) => { releaseFirst = resolve })
    return [fetched("latest", "---\nname: Latest\n---\ncurrent")]
  })
  try {
    const first = world.service.synchronize("startup")
    const second = world.service.synchronize("auth_change")
    const third = world.service.synchronize("on_demand")
    assert.equal(fetches, 1)
    releaseFirst([fetched("earlier")])
    await Promise.all([first, second, third])
    assert.equal(fetches, 2)
    assert.deepEqual(readManagedSkillsCache(world.cacheDir)?.skills.map(({ id }) => id), ["latest"])
  } finally {
    world.service.dispose()
    world.disposeFiles()
  }
})

test("refresh failures are reported and keep the prior cache intact", async () => {
  const world = cacheWorld(async () => { throw new Error("offline") })
  try {
    writeManagedSkillsCache(world.cacheDir, [{ id: "kept", name: "Kept", description: "", body: "body" }])
    await world.service.synchronize("startup")
    assert.deepEqual(readManagedSkillsCache(world.cacheDir)?.skills.map(({ id }) => id), ["kept"])
    assert.deepEqual(world.reports, [{ extension: "managed_setup", kind: "managed_skills", errorClass: "Error" }])
  } finally {
    world.service.dispose()
    world.disposeFiles()
  }
})

test("disposing during a fetch prevents its result from being written", async () => {
  let release!: (skills: readonly FetchedManagedSkill[]) => void
  const world = cacheWorld(() => new Promise((resolve) => { release = resolve }))
  try {
    const pending = world.service.synchronize("startup")
    world.service.dispose()
    release([fetched("late")])
    await pending
    assert.equal(readManagedSkillsCache(world.cacheDir), null)
  } finally {
    world.disposeFiles()
  }
})

test("startup and authentication changes each trigger a refresh", async () => {
  const triggers: string[] = []
  const world = cacheWorld(async () => {
    triggers.push("fetch")
    return [fetched("skill")]
  })
  try {
    world.service.start()
    await waitForCurrentTurn()
    world.service.onAuthenticationReady()
    await waitForCurrentTurn()
    assert.deepEqual(triggers, ["fetch", "fetch"])
  } finally {
    world.service.dispose()
    world.disposeFiles()
  }
})
