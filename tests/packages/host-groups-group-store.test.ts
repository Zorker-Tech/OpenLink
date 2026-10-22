import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, it } from "node:test";

import {
  GROUP_CONFIG_VERSION,
  GROUP_MAX_MEMBERS,
  SLATE_GROUP_FILENAME,
  getSlateGroupPath,
  isSlateGroupDir,
  normalizeMemberIds,
  normalizeRemoteMembers,
  readSlateGroupConfig,
  writeSlateGroupConfig,
} from "../../source/host/groups/group-store.ts";

const temporaryDirectory = () => mkdtempSync(path.join(tmpdir(), "slate-group-store-"));

describe("a group's file and its limits", () => {
  it("sits beside its agent, and is bounded", () => {
    assert.equal(SLATE_GROUP_FILENAME, "group.json");
    assert.equal(GROUP_CONFIG_VERSION, 1);
    assert.equal(GROUP_MAX_MEMBERS, 6);
    assert.equal(getSlateGroupPath("/tmp/agent"), path.join("/tmp/agent", "group.json"));
  });

  it("normalizes local member ids: trimmed, de-duplicated, and capped", () => {
    assert.deepEqual(normalizeMemberIds("not a list"), []);
    assert.deepEqual(normalizeMemberIds([" a ", "\tb", ""]), ["a", "b"]);
    assert.deepEqual(normalizeMemberIds(["a", "a ", " a", 1, null, "b"]), ["a", "b"]);
    assert.deepEqual(normalizeMemberIds(["a", "b", "c", "d", "e", "f", "g"]), ["a", "b", "c", "d", "e", "f"]);
  });

  it("normalizes remote members: keyed by owner and agent, named, with an optional picture", () => {
    assert.deepEqual(normalizeRemoteMembers("not a list"), []);
    assert.deepEqual(normalizeRemoteMembers([{ ownerAuthId: " o ", agentId: " a ", name: " N " }]), [{ ownerAuthId: "o", agentId: "a", name: "N" }]);
    assert.deepEqual(normalizeRemoteMembers([{ ownerAuthId: "o", agentId: "a" }]), [{ ownerAuthId: "o", agentId: "a", name: "Agent" }]);
    assert.deepEqual(normalizeRemoteMembers([{ ownerAuthId: "o", agentId: "a", name: "  " }]), [{ ownerAuthId: "o", agentId: "a", name: "Agent" }]);
    assert.deepEqual(normalizeRemoteMembers([{ ownerAuthId: "o", agentId: "a", avatarDataUrl: "data:x" }]), [{ ownerAuthId: "o", agentId: "a", name: "Agent", avatarDataUrl: "data:x" }]);
    assert.deepEqual(normalizeRemoteMembers([{ ownerAuthId: "o", agentId: "a", avatarDataUrl: "" }]), [{ ownerAuthId: "o", agentId: "a", name: "Agent" }]);
    assert.deepEqual(normalizeRemoteMembers([{ ownerAuthId: "o", agentId: "a" }, { ownerAuthId: " o ", agentId: " a " }, { ownerAuthId: "o2", agentId: "a" }]), [{ ownerAuthId: "o", agentId: "a", name: "Agent" }, { ownerAuthId: "o2", agentId: "a", name: "Agent" }]);
    assert.deepEqual(normalizeRemoteMembers([null, "x", 1, [], { ownerAuthId: 1, agentId: "a" }, { ownerAuthId: "o", agentId: 2 }]), []);
    assert.deepEqual(
      normalizeRemoteMembers([{ ownerAuthId: "a:b", agentId: "c" }, { ownerAuthId: "a", agentId: "b:c" }]),
      [{ ownerAuthId: "a:b", agentId: "c", name: "Agent" }, { ownerAuthId: "a", agentId: "b:c", name: "Agent" }],
      "the owner/agent separator is not a character either can contain away from the other",
    );
  });
});

describe("reading a group from its file", () => {
  it("answers nothing when the file is missing, unreadable, or says nothing", () => {
    const baseDir = temporaryDirectory();
    try {
      assert.equal(readSlateGroupConfig(baseDir), null);
      writeFileSync(path.join(baseDir, "group.json"), "not json", "utf8");
      assert.equal(readSlateGroupConfig(baseDir), null);
      writeFileSync(path.join(baseDir, "group.json"), "null", "utf8");
      assert.equal(readSlateGroupConfig(baseDir), null);
      writeFileSync(path.join(baseDir, "group.json"), "{}", "utf8");
      assert.equal(readSlateGroupConfig(baseDir), null);
      writeFileSync(path.join(baseDir, "group.json"), JSON.stringify({ sharedRoomId: "" }), "utf8");
      assert.equal(readSlateGroupConfig(baseDir), null);
      writeFileSync(path.join(baseDir, "group.json"), JSON.stringify({ sharedRoomId: "room-1" }), "utf8");
      assert.deepEqual(readSlateGroupConfig(baseDir), { version: GROUP_CONFIG_VERSION, memberIds: [], sharedRoomId: "room-1" }, "a shared room on its own is a group");
    } finally {
      rmSync(baseDir, { recursive: true, force: true });
    }
  });

  it("reads a group back, filling in the version and normalizing what it can", () => {
    const baseDir = temporaryDirectory();
    try {
      writeFileSync(path.join(baseDir, "group.json"), JSON.stringify({
        version: 2,
        memberIds: [" a ", "a", "b"],
        remoteMembers: [{ ownerAuthId: " o ", agentId: " a ", name: " N ", avatarDataUrl: "data:x" }],
        sharedRoomId: "room-1",
      }), "utf8");
      assert.deepEqual(readSlateGroupConfig(baseDir), {
        version: 2,
        memberIds: ["a", "b"],
        remoteMembers: [{ ownerAuthId: "o", agentId: "a", name: "N", avatarDataUrl: "data:x" }],
        sharedRoomId: "room-1",
      });
      writeFileSync(path.join(baseDir, "group.json"), JSON.stringify({ memberIds: ["a"] }), "utf8");
      assert.deepEqual(readSlateGroupConfig(baseDir), { version: GROUP_CONFIG_VERSION, memberIds: ["a"] });
      assert.equal(isSlateGroupDir(baseDir), true);
    } finally {
      rmSync(baseDir, { recursive: true, force: true });
    }
  });
});

describe("writing a group to its file", () => {
  it("creates the directory and writes the normalized group as pretty JSON with a newline", () => {
    const root = temporaryDirectory();
    try {
      const agentDir = path.join(root, "agents", "one");
      writeSlateGroupConfig(agentDir, {
        version: 2,
        memberIds: [" a ", "a", "b"],
        remoteMembers: [{ ownerAuthId: " o ", agentId: " a ", name: " N ", avatarDataUrl: "data:x" }],
        sharedRoomId: "room-1",
      });
      assert.equal(readFileSync(path.join(agentDir, "group.json"), "utf8"), JSON.stringify({
        version: 2,
        memberIds: ["a", "b"],
        remoteMembers: [{ ownerAuthId: "o", agentId: "a", name: "N", avatarDataUrl: "data:x" }],
        sharedRoomId: "room-1",
      }, null, 2) + "\n");
      assert.deepEqual(readSlateGroupConfig(agentDir), {
        version: 2,
        memberIds: ["a", "b"],
        remoteMembers: [{ ownerAuthId: "o", agentId: "a", name: "N", avatarDataUrl: "data:x" }],
        sharedRoomId: "room-1",
      });
      assert.equal(isSlateGroupDir(agentDir), true);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("leaves out the empty fields and keeps a blank shared room out", () => {
    const root = temporaryDirectory();
    try {
      const agentDir = path.join(root, "agent");
      writeSlateGroupConfig(agentDir, { version: 0, memberIds: [], remoteMembers: [], sharedRoomId: "" });
      assert.equal(readFileSync(path.join(agentDir, "group.json"), "utf8"), '{\n  "version": 0,\n  "memberIds": []\n}\n');
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});