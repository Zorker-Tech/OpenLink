import assert from "node:assert/strict"
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { after, test } from "node:test"

import { CANONICAL_AVATAR_FILENAME, listConventionalAvatarFilenames } from "../../source/host/agents/agent-avatar.ts"
import { getSlateProfilePath, writeSlateProfileFile } from "../../source/host/agents/agent-profile.ts"
import {
  recoverAgentWithMissingDb,
  setAgentAvatarBytes,
  type MutationDb,
} from "../../source/host/extensions/session/session-mutations.ts"

const roots: string[] = []
after(() => { for (const root of roots) rmSync(root, { recursive: true, force: true }) })
const freshRoot = () => { const root = mkdtempSync(join(tmpdir(), "slate-session-mutations-")); roots.push(root); return root }

function dbFixture(initialProfile: { description: string; avatarPath: string | null } = { description: "about Ada", avatarPath: null }) {
  let profile = initialProfile
  const profileWrites: Array<{ description: string; avatarPath: string | null }> = []
  const db: MutationDb = {
    getSlateProfile: () => profile,
    setSlateProfile: value => { profile = value; profileWrites.push(value); return true },
    get: key => key === "agentId" ? "agent-1" : key === "name" ? "Ada" : key === "createdAt" ? 10 : undefined,
    getTranscriptEntries: () => [],
    getUnreadState: () => ({ lastActivityAt: 10, lastViewedAt: 10, isManuallyUnread: false, unreadCount: 0 }),
  }
  return { db, profileWrites, profile: () => profile }
}

test("writing avatar bytes replaces conventional files and leaves profile metadata alone", async () => {
  const root = freshRoot()
  const agentDir = join(root, "agent-1")
  const dbPath = join(agentDir, "store.db")
  mkdirSync(agentDir, { recursive: true })
  writeFileSync(join(agentDir, "avatar.jpg"), "old jpg")
  writeFileSync(join(agentDir, "avatar.webp"), "old webp")
  const world = dbFixture()
  const png = Uint8Array.from([137, 80, 78, 71, 13, 10, 26, 10])

  const summary = await setAgentAvatarBytes(
    { memory: { agentHasContent: () => false } },
    world.db,
    dbPath,
    "agent-1",
    png,
    "active-agent",
  )

  assert.deepEqual(listConventionalAvatarFilenames(agentDir), [CANONICAL_AVATAR_FILENAME])
  assert.deepEqual(readFileSync(join(agentDir, CANONICAL_AVATAR_FILENAME)), Buffer.from(png))
  assert.deepEqual(world.profileWrites, [])
  assert.equal(summary?.id, "agent-1")
  assert.equal(summary?.name, "Ada")
})

test("clearing an avatar removes every conventional file and clears only a stored legacy path", async () => {
  const root = freshRoot()
  const agentDir = join(root, "agent-1")
  const dbPath = join(agentDir, "store.db")
  mkdirSync(agentDir, { recursive: true })
  writeFileSync(join(agentDir, "avatar.png"), "png")
  writeFileSync(join(agentDir, "avatar.gif"), "gif")
  const world = dbFixture({ description: "keep this", avatarPath: "legacy-avatar.png" })

  await setAgentAvatarBytes({ memory: { agentHasContent: () => false } }, world.db, dbPath, "agent-1", null)

  assert.deepEqual(listConventionalAvatarFilenames(agentDir), [])
  assert.deepEqual(world.profileWrites, [{ description: "keep this", avatarPath: null }])
  assert.equal(world.profile().description, "keep this")
})

test("a missing database is reseeded only when durable session data proves it can be recovered", async () => {
  const root = freshRoot()
  const agentDir = join(root, "agent-1")
  const dbPath = join(agentDir, "store.db")
  mkdirSync(agentDir, { recursive: true })
  writeSlateProfileFile(getSlateProfilePath(agentDir), {
    name: "Ada",
    description: "A profile",
    title: "",
    avatarShape: "",
    avatarColor: "",
  })
  let reseeds = 0
  const host = {
    memory: { agentHasContent: () => false },
    isAgentBeingDeleted: () => false,
    hasLiveDbHandle: () => false,
    reseedMinimalStoreDbIfMissing: (path: string) => { reseeds += 1; writeFileSync(path, "reseeded") },
  }

  const recovered = await recoverAgentWithMissingDb(host, { dbPath, dirName: "agent-1", activeAgentId: "agent-1" })
  assert.equal(reseeds, 1)
  assert.equal(existsSync(dbPath), true)
  assert.equal(recovered?.id, "agent-1")
  assert.equal(recovered?.name, "Ada")
})

test("deleting agents and sessions with no durable footprint are not recreated", async () => {
  const root = freshRoot()
  const deletingRoot = join(root, "deleting")
  const emptyRoot = join(root, "empty")
  mkdirSync(deletingRoot, { recursive: true })
  mkdirSync(emptyRoot, { recursive: true })
  let reseeds = 0
  const shared = {
    memory: { agentHasContent: () => false },
    reseedMinimalStoreDbIfMissing: () => { reseeds += 1 },
  }

  assert.equal(await recoverAgentWithMissingDb({
    ...shared,
    isAgentBeingDeleted: () => true,
  }, { dbPath: join(deletingRoot, "store.db"), dirName: "deleting" }), null)
  assert.equal(await recoverAgentWithMissingDb({
    ...shared,
    isAgentBeingDeleted: () => false,
  }, { dbPath: join(emptyRoot, "store.db"), dirName: "empty" }), null)
  assert.equal(reseeds, 0)
})

test("an open database handle is left alone during session recovery", async () => {
  const root = freshRoot()
  const agentDir = join(root, "agent-1")
  const dbPath = join(agentDir, "store.db")
  mkdirSync(agentDir, { recursive: true })
  writeSlateProfileFile(getSlateProfilePath(agentDir), {
    name: "Ada",
    description: "A profile",
    title: "",
    avatarShape: "",
    avatarColor: "",
  })
  let reseeds = 0
  const recovered = await recoverAgentWithMissingDb({
    memory: { agentHasContent: () => false },
    isAgentBeingDeleted: () => false,
    hasLiveDbHandle: () => true,
    reseedMinimalStoreDbIfMissing: () => { reseeds += 1 },
  }, { dbPath, dirName: "agent-1" })

  assert.equal(reseeds, 0)
  assert.equal(recovered?.name, "Ada")
})
