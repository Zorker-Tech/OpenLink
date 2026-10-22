import { test } from "node:test"
import assert from "node:assert/strict"
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"

import { resolveProfileName, SlateAgentSessionStore } from "../../source/host/extensions/session/agent-session.ts"
import { agentSettingsAt, getSlateSettingsPath } from "../../source/host/agents/settings-file.ts"

const withStore = (run: (store: SlateAgentSessionStore, root: string) => void): void => {
  const root = mkdtempSync(join(tmpdir(), "slate-session-store-test-"))
  try {
    run(new SlateAgentSessionStore(root), root)
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
}

test("a profile is named by what it is given, what it had, and then the default", () => {
  assert.equal(resolveProfileName("Named"), "Named")
  assert.equal(resolveProfileName("  Named  "), "  Named  ", "the caller trims the name before asking")
  assert.equal(resolveProfileName("", { name: "Current" }), "Current")
  assert.equal(resolveProfileName("", { name: "  " }), "New Bot")
  assert.equal(resolveProfileName("", { name: "" }), "New Bot")
  assert.equal(resolveProfileName("", null), "New Bot")
  assert.equal(resolveProfileName("Named", { name: "Current" }), "Named")
})

test("a session's profile, pointer and settings are kept beside the agent", () => {
  withStore((store, root) => {
    assert.equal(store.getRootDir(), root)
    assert.equal(store.getAgentDir("a"), join(root, "a"))
    assert.equal(store.agentDirExists("a"), false)
    assert.equal(store.readActiveAgentId(), null)

    store.writeActiveAgentId("a")
    assert.equal(store.readActiveAgentId(), "a")
    assert.deepEqual(JSON.parse(readFileSync(store.activeAgentPointerPath(), "utf8")), { activeAgentId: "a" })

    store.writeAgentProfileFile("a", { name: "Named", description: "  padded  " })
    assert.deepEqual(store.getAgentProfileText("a"), { name: "Named", description: "padded", title: "", avatarShape: "", avatarColor: "" })
    assert.equal(store.agentDirExists("a"), true)

    store.setSessionNotifyOnUpdates("a", false)
    store.setSessionHiddenFromSidebar("a", true)
    assert.deepEqual(agentSettingsAt(getSlateSettingsPath(store.getAgentDir("a"))), { notifyOnAgentUpdates: false, hiddenFromSidebar: true })

    store.setUserTimeZoneResolver(() => "UTC")
    assert.equal(store.getUserTimeZone(), "UTC")
  })
})

test("a session that needs a conversation-state provider says so", async () => {
  withStore(async (store) => {
    await assert.rejects(store.getSessionOutline({ id: "a", dbPath: join(store.getRootDir(), "a", "db"), db: {}, agentStore: { dispose: async () => {} } } as never), /Session conversation-state provider is required/)
    await assert.rejects(store.getAgentOutline("a"), /Session conversation-state provider is required/)
  })
})

test("deleting a session takes its directory with it", async () => {
  const root = mkdtempSync(join(tmpdir(), "slate-session-store-test-"))
  try {
    const store = new SlateAgentSessionStore(root)
    store.writeAgentProfileFile("a", { name: "Named", description: "" })
    writeFileSync(join(root, "a", "extra.txt"), "x")
    assert.equal(store.agentDirExists("a"), true)
    await store.deleteSession("a")
    assert.equal(store.agentDirExists("a"), false)
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})
