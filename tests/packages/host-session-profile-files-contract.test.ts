import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { createHash } from "node:crypto";
import { describe, it } from "node:test";

import {
  avatarBasename,
  getAgentAvatar,
  getAgentAvatarPng,
  getAgentProfileText,
  readLegacyStoredAvatar,
  updateAgentProfile,
} from "../../source/host/extensions/session/session-profile-files.ts";
import { getSlateProfilePath, readSlateProfileFile, writeSlateProfileFile } from "../../source/host/agents/agent-profile.ts";

function agentDirectory() {
  const root = mkdtempSync(join(tmpdir(), "slate-session-profile-contract-"));
  const directory = join(root, "agent-1");
  mkdirSync(directory);
  return { root, directory, dispose: () => rmSync(root, { recursive: true, force: true }) };
}

describe("session profile and avatar file operations", () => {
  it("projects only profile text fields and returns nothing for a missing profile", () => {
    const fixture = agentDirectory();
    try {
      const profilePath = getSlateProfilePath(fixture.directory);
      writeSlateProfileFile(profilePath, {
        name: " Ada ", description: " builds ", title: " Guide ", avatarShape: " circle ", avatarColor: " blue ",
      });
      assert.deepEqual(getAgentProfileText({ getAgentDir: () => fixture.directory }, "agent-1"), {
        name: "Ada", description: "builds", title: "Guide", avatarShape: "circle", avatarColor: "blue",
      });
      rmSync(profilePath);
      assert.equal(getAgentProfileText({ getAgentDir: () => fixture.directory }, "agent-1"), null);
    } finally {
      fixture.dispose();
    }
  });

  it("writes an updated profile before rebuilding the summary from the session store", async () => {
    const fixture = agentDirectory();
    const calls: string[] = [];
    const activity = { lastActivityAt: 0 };
    const db = {
      get: (key: string) => key === "agentId" ? "agent-1" : key === "createdAt" ? 10 : new Uint8Array([1]),
      getTranscriptEntries: () => [],
      getUnreadState: () => ({ ...activity, lastViewedAt: 0, isManuallyUnread: false, unreadCount: 0 }),
      getSlateProfile: () => ({ description: "new description", avatarPath: null }),
      markActivity: (time: number) => { calls.push("markActivity"); activity.lastActivityAt = time; },
    };
    try {
      const summary = await updateAgentProfile({
        memory: { agentHasContent: () => false },
        withAgentDb: async (_id, action) => await action(db, join(fixture.directory, "store.db")),
        statOpenDb: async () => ({ size: 8, mtimeMs: 50 }),
        writeAgentProfileFile: (id, profile) => {
          calls.push(`write:${id}`);
          writeSlateProfileFile(getSlateProfilePath(join(fixture.root, id)), {
            ...profile,
            title: profile.title ?? "",
            avatarShape: profile.avatarShape ?? "",
            avatarColor: profile.avatarColor ?? "",
          });
        },
      }, "agent-1", { name: " Ada ", description: " new description " });
      assert.equal(calls[0], "write:agent-1");
      assert.ok(summary);
      assert.equal(readSlateProfileFile(getSlateProfilePath(fixture.directory))?.name, "Ada");
      assert.equal(summary.name, "Ada");
      assert.equal(summary.description, "new description");
      assert.equal(summary.updatedAt, 50);
    } finally {
      fixture.dispose();
    }
  });

  it("derives a contained legacy avatar into a canonical file and reads both data forms", async () => {
    const fixture = agentDirectory();
    const png = Uint8Array.from([137, 80, 78, 71, 13, 10, 26, 10]);
    try {
      writeFileSync(getSlateProfilePath(fixture.directory), JSON.stringify({ avatar: "legacy.png" }));
      writeFileSync(join(fixture.directory, "legacy.png"), png);
      const db = { getSlateProfile: () => ({ avatarPath: null }) };
      const host = {
        agentExists: () => true,
        getAgentDir: () => fixture.directory,
        withAgentDb: async <T>(_id: string, action: (database: typeof db) => Promise<T>) => await action(db),
      };
      const avatar = await getAgentAvatar(host, "agent-1");
      assert.equal(avatar.dataUrl, `data:image/png;base64,${Buffer.from(png).toString("base64")}`);
      assert.equal(avatar.version, createHash("sha256").update(png).digest("hex").slice(0, 16));
      assert.deepEqual(Array.from((await getAgentAvatarPng(host, "agent-1"))!), Array.from(png));
      assert.equal(avatarBasename("/some/path/avatar.png"), "avatar.png");
    } finally {
      fixture.dispose();
    }
  });

  it("reads the database's legacy avatar path only for an existing agent", async () => {
    const fixture = agentDirectory();
    let databaseReads = 0;
    try {
      const db = { getSlateProfile: () => ({ avatarPath: "legacy.png" }) };
      const host = {
        agentExists: (id: string) => id === "agent-1",
        getAgentDir: () => fixture.directory,
        withAgentDb: async <T>(_id: string, action: (database: typeof db) => Promise<T>) => {
          databaseReads += 1;
          return await action(db);
        },
      };
      const read = async (dir: string, path: string | null) => path == null ? null : `${dir}:${path}`;
      assert.equal(await readLegacyStoredAvatar({ ...host, agentExists: () => false }, "agent-1", read), null);
      assert.equal(databaseReads, 0);
      assert.equal(await readLegacyStoredAvatar(host, "agent-1", read), `${fixture.directory}:legacy.png`);
      assert.equal(databaseReads, 1);
    } finally {
      fixture.dispose();
    }
  });
});
