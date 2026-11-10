import { test } from "node:test"
import assert from "node:assert/strict"
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"

import {
  getSlateRemoteRoomPath,
  isSlateRemoteRoomDir,
  normalizeRemoteRoomMembers,
  readSlateRemoteRoomConfig,
  REMOTE_ROOM_CONFIG_VERSION,
  SLATE_REMOTE_ROOM_FILENAME,
  writeSlateRemoteRoomConfig,
} from "../../source/host/groups/remote-room-store.ts"

const withTempDir = (run: (dir: string) => void): void => {
  const dir = mkdtempSync(join(tmpdir(), "slate-remote-room-test-"))
  try {
    run(dir)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
}

test("the room lives beside the agent in one file of a versioned shape", () => {
  assert.equal(SLATE_REMOTE_ROOM_FILENAME, "remote-room.json")
  assert.equal(REMOTE_ROOM_CONFIG_VERSION, 1)
  assert.equal(getSlateRemoteRoomPath("/agents/mine"), join("/agents/mine", "remote-room.json"))
})

test("a member that names nobody is dropped, and a missing name is filled in", () => {
  assert.deepEqual(normalizeRemoteRoomMembers(undefined), [])
  assert.deepEqual(normalizeRemoteRoomMembers("text"), [])
  assert.deepEqual(
    normalizeRemoteRoomMembers([
      { authId: "a", kind: "agent", agentId: "ag", displayName: "A" },
      { authId: "", kind: "agent" },
      { kind: "agent" },
      { authId: 7 },
      null,
      7,
      { authId: "b" },
      { authId: "c", kind: "other", agentId: 7, displayName: "" },
      { authId: "d", displayName: "  ", avatarUrl: "u" },
      { authId: "e", avatarUrl: "" },
    ]),
    [
      { kind: "agent", authId: "a", agentId: "ag", displayName: "A" },
      { kind: "human", authId: "b", agentId: "", displayName: "Someone" },
      { kind: "human", authId: "c", agentId: "", displayName: "Someone" },
      { kind: "human", authId: "d", agentId: "", displayName: "  ", avatarUrl: "u" },
      { kind: "human", authId: "e", agentId: "", displayName: "Someone" },
    ],
  )

  const many = Array.from({ length: 30 }, (_, index) => ({ authId: "m" + index }))
  const bounded = normalizeRemoteRoomMembers(many)
  assert.equal(bounded.length, 24, "a hand-edited file cannot make the room unbounded")
  assert.equal(bounded[23]?.authId, "m23")
})

test("a room is read defensively, and an unreadable file is not a room", () => {
  withTempDir((dir) => {
    assert.equal(readSlateRemoteRoomConfig(dir), null, "no file is no room")
    assert.equal(isSlateRemoteRoomDir(dir), false)

    writeFileSync(getSlateRemoteRoomPath(dir), "not json", "utf8")
    assert.equal(readSlateRemoteRoomConfig(dir), null)
    assert.equal(isSlateRemoteRoomDir(dir), false)

    writeFileSync(getSlateRemoteRoomPath(dir), JSON.stringify({ hostAuthId: "h" }), "utf8")
    assert.equal(readSlateRemoteRoomConfig(dir), null, "a room needs both the room and its host")
    writeFileSync(getSlateRemoteRoomPath(dir), JSON.stringify({ roomId: "r" }), "utf8")
    assert.equal(readSlateRemoteRoomConfig(dir), null, "a host is needed as much as a room")
    writeFileSync(getSlateRemoteRoomPath(dir), JSON.stringify({ roomId: "", hostAuthId: "h" }), "utf8")
    assert.equal(readSlateRemoteRoomConfig(dir), null, "an empty room name is no room")

    writeFileSync(getSlateRemoteRoomPath(dir), JSON.stringify({ roomId: "r", hostAuthId: "h" }), "utf8")
    assert.deepEqual(readSlateRemoteRoomConfig(dir), {
      version: REMOTE_ROOM_CONFIG_VERSION,
      roomId: "r",
      hostAuthId: "h",
      hostName: "The host",
      members: [],
    }, "the file's omissions are filled in")
    assert.equal(isSlateRemoteRoomDir(dir), true)

    writeFileSync(getSlateRemoteRoomPath(dir), JSON.stringify({ roomId: "r", hostAuthId: "h", hostName: "", version: 2, isRevoked: "true" }), "utf8")
    assert.deepEqual(readSlateRemoteRoomConfig(dir), {
      version: 2,
      roomId: "r",
      hostAuthId: "h",
      hostName: "The host",
      members: [],
    }, "an empty name is no name, and only the boolean true means revoked")

    writeFileSync(getSlateRemoteRoomPath(dir), JSON.stringify({ roomId: "r", hostAuthId: "h", hostName: "Host", hostAvatarUrl: "u", isRevoked: true, members: [{ authId: "a" }] }), "utf8")
    assert.deepEqual(readSlateRemoteRoomConfig(dir), {
      version: 1,
      roomId: "r",
      hostAuthId: "h",
      hostName: "Host",
      hostAvatarUrl: "u",
      members: [{ kind: "human", authId: "a", agentId: "", displayName: "Someone" }],
      isRevoked: true,
    })

    // A file that parses to nothing is a failure to read, not a room.
    writeFileSync(getSlateRemoteRoomPath(dir), "null", "utf8")
    assert.throws(() => readSlateRemoteRoomConfig(dir), TypeError)
  })
})

test("a written room is the file the reader understands, newline and all", () => {
  withTempDir((dir) => {
    const agentDir = join(dir, "nested", "agent")
    const config = {
      version: 1,
      roomId: "r",
      hostAuthId: "h",
      hostName: "Host",
      members: [{ kind: "agent" as const, authId: "a", agentId: "ag", displayName: "A" }],
    }
    writeSlateRemoteRoomConfig(agentDir, config)
    assert.equal(readFileSync(getSlateRemoteRoomPath(agentDir), "utf8"), JSON.stringify(config, null, 2) + "\n", "the file is the room, indented, and ends with a newline")
    assert.equal(isSlateRemoteRoomDir(agentDir), true)
    assert.deepEqual(readSlateRemoteRoomConfig(agentDir), config)
  })
})
