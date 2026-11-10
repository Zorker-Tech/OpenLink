import assert from "node:assert/strict"
import { mkdtempSync, mkdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import path from "node:path"
import { test } from "node:test"

import {
  CHANNEL_CHANGE_DEBOUNCE_MS,
  CHANNEL_CONFIG_FILENAME,
  CHANNELS_DIRNAME,
  FileChannelStore,
  getAgentChannelsDir,
} from "../../source/host/extensions/session/channel-store.ts"
import {
  channelDisplayName,
  normalizeChannelLabel,
} from "../../source/host/extensions/session/channel-store-labels.ts"

function inTemporaryDirectory(run: (root: string) => void): void {
  const root = mkdtempSync(path.join(tmpdir(), "slate-channel-store-"))
  try {
    run(root)
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
}

test("channel paths and change timing stay inside the session's channel directory", () => {
  const root = path.join(tmpdir(), "agent-1")
  const channelDir = getAgentChannelsDir(root)
  const store = new FileChannelStore(channelDir)

  assert.equal(CHANNELS_DIRNAME, "channels")
  assert.equal(CHANNEL_CONFIG_FILENAME, "connection.json")
  assert.equal(CHANNEL_CHANGE_DEBOUNCE_MS, 50)
  assert.equal(store.getLocation(), channelDir)
  assert.equal(store.configPath("chat"), path.join(channelDir, "chat", "connection.json"))
})

test("stored labels collapse whitespace, trim edges and stop at eighty characters", () => {
  assert.equal(normalizeChannelLabel("  release\n   review  "), "release review")
  assert.equal(normalizeChannelLabel("x".repeat(81)), "x".repeat(80))
  assert.equal(channelDisplayName("  Team inbox  "), "Team inbox")
  assert.equal(channelDisplayName("  "), "Connected channel")
})

test("metadata writes are atomic and become configured channel entries", () => {
  inTemporaryDirectory((root) => {
    const channelDir = getAgentChannelsDir(root)
    const store = new FileChannelStore(channelDir)

    assert.equal(store.writeMetadata("mail", "  Evening\n shift  "), true)
    const configPath = store.configPath("mail")
    assert.equal(readFileSync(configPath, "utf8"), '{\n  "label": "Evening shift"\n}\n')
    assert.equal(statSync(`${configPath}.tmp`, { throwIfNoEntry: false }), undefined)
    assert.deepEqual(store.listConnections(), [
      { platform: "mail", label: "Evening shift", status: "configured" },
    ])
  })
})

test("listing ignores unsafe folders, files and malformed configuration", () => {
  inTemporaryDirectory((root) => {
    const channelDir = getAgentChannelsDir(root)
    mkdirSync(channelDir, { recursive: true })
    const writeConfig = (platform: string, contents: string) => {
      const folder = path.join(channelDir, platform)
      mkdirSync(folder, { recursive: true })
      writeFileSync(path.join(folder, CHANNEL_CONFIG_FILENAME), contents)
    }
    writeConfig("alpha", '{"label":"Alpha"}')
    writeConfig("unlabeled", "{}")
    writeConfig("broken", "not-json")
    writeConfig("wrong-shape", "[]")
    writeConfig("unsafe\\folder", '{"label":"Unsafe"}')
    writeFileSync(path.join(channelDir, "plain-file"), "not a folder")

    const store = new FileChannelStore(channelDir)
    assert.deepEqual(store.listPlatforms(), ["alpha", "unlabeled"])
    assert.deepEqual(store.listConnections(), [
      { platform: "alpha", label: "Alpha", status: "configured" },
      { platform: "unlabeled", label: "Connected channel", status: "configured" },
    ])
  })
})

test("unsafe ids and non-directory removals are refused; a valid channel is removed recursively", () => {
  inTemporaryDirectory((root) => {
    const channelDir = getAgentChannelsDir(root)
    const store = new FileChannelStore(channelDir)
    assert.equal(store.writeMetadata("../escape", "not stored"), false)
    assert.equal(store.remove("../escape"), false)

    mkdirSync(channelDir, { recursive: true })
    writeFileSync(path.join(channelDir, "regular-file"), "keep")
    assert.equal(store.remove("regular-file"), false)
    assert.equal(readFileSync(path.join(channelDir, "regular-file"), "utf8"), "keep")

    assert.equal(store.writeMetadata("team-chat", "Team chat"), true)
    writeFileSync(path.join(channelDir, "team-chat", "token.json"), "credential")
    assert.equal(store.remove("team-chat"), true)
    assert.equal(statSync(path.join(channelDir, "team-chat"), { throwIfNoEntry: false }), undefined)
    assert.equal(store.remove("team-chat"), false)
  })
})
