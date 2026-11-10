import assert from "node:assert/strict";
import { existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

import { getSlateProfilePath, readSlateProfileFile, writeSlateProfileFile } from "../../source/host/agents/agent-profile.ts";
import { agentSettingsAt, getSlateSettingsPath, writeAgentSettings } from "../../source/host/agents/settings-file.ts";
import {
  agentHasDurableFootprint,
  agentHasQuarantinedStoreDb,
  buildSummary,
  loadAgentDbExtras,
  minimalAgentSummary,
  readDbExtras,
  type DbExtras,
  type SummaryDb,
} from "../../source/host/extensions/session/session-summaries.ts";

type UnreadState = DbExtras["unreadState"];

interface FakeDb extends SummaryDb {
  markActivity(at: number): void;
  readonly activityMarks: number[];
}

function makeDb(options: {
  values?: Record<string, unknown>;
  entries?: Record<string, unknown>[];
  unread?: UnreadState;
  awaiting?: unknown;
  origin?: unknown;
  purpose?: unknown;
  partners?: string[];
  profile?: { description: string; avatarPath: string | null };
  failEntries?: boolean;
} = {}): FakeDb {
  const values: Record<string, unknown> = { agentId: "agent-db", createdAt: 20, latestRootBlobId: undefined, ...options.values };
  const entries = options.entries ?? [];
  let unread = options.unread ?? { lastActivityAt: 0, lastViewedAt: 0, isManuallyUnread: false, unreadCount: 0 };
  const activityMarks: number[] = [];
  const optional: Partial<SummaryDb> = {};
  if (options.awaiting !== undefined) optional.getAwaitingUserResponse = () => options.awaiting;
  if (options.origin !== undefined) optional.getAgentOrigin = () => options.origin;
  if (options.purpose !== undefined) optional.getAgentPurpose = () => options.purpose;
  if (options.partners !== undefined) optional.getConversationPartnerIds = () => options.partners as string[];
  if (options.profile !== undefined) optional.getSlateProfile = () => options.profile as { description: string; avatarPath: string | null };
  return {
    get: (key) => values[key],
    getTranscriptEntries: () => {
      if (options.failEntries) throw new Error("transcript unavailable");
      return entries;
    },
    getUnreadState: () => unread,
    markActivity: (at) => {
      activityMarks.push(at);
      unread = { ...unread, lastActivityAt: at, unreadCount: Math.max(unread.unreadCount, 1) };
    },
    activityMarks,
    ...optional,
  };
}

function extras(overrides: Partial<DbExtras> = {}): DbExtras {
  return {
    agentId: "agent-db",
    createdAt: 20,
    updatedAt: 20,
    hasTranscript: true,
    lastEntry: { kind: "text", text: "latest" },
    lastMessage: { id: "message-1", preview: "latest" },
    newestEntryId: "entry-1",
    unreadState: { lastActivityAt: 20, lastViewedAt: 0, isManuallyUnread: false, unreadCount: 1 },
    awaitingUserResponse: null,
    origin: "user",
    purpose: null,
    conversationPartnerIds: [],
    legacyAvatarPath: null,
    ...overrides,
  };
}

async function withAgentDir(run: (agentDir: string, dbPath: string) => Promise<void>): Promise<void> {
  const agentDir = mkdtempSync(join(tmpdir(), "slate-session-summary-contract-"));
  const dbPath = join(agentDir, "store.db");
  try {
    await run(agentDir, dbPath);
  } finally {
    rmSync(agentDir, { recursive: true, force: true });
  }
}

test("DB extras combine transcript projections, database metadata and mtime-seeded activity", () => {
  const db = makeDb({
    values: { agentId: "agent-from-db", createdAt: "20", latestRootBlobId: new Uint8Array([1]) },
    entries: [
      { kind: "message", id: "visible-entry", role: "user", content: "visible" },
      { kind: "send-message", id: "hidden-message", hidden: true, message: { type: "text", content: "latest hidden message" } },
    ],
    unread: { lastActivityAt: 0, lastViewedAt: 5, isManuallyUnread: false, unreadCount: 0 },
    awaiting: { reason: "choose" },
    origin: "shared",
    purpose: "workflow",
    partners: ["peer-a"],
    profile: { description: "profile", avatarPath: "legacy-avatar.png" },
  });
  const value = readDbExtras(db, "directory-id", { mtimeMs: 53.9 });
  assert.deepEqual(db.activityMarks, [53]);
  assert.deepEqual(value, {
    agentId: "agent-from-db",
    createdAt: 20,
    updatedAt: 53,
    hasTranscript: true,
    lastEntry: { kind: "text", text: "visible" },
    lastMessage: { id: "hidden-message", preview: "latest hidden message" },
    newestEntryId: "hidden-message",
    unreadState: { lastActivityAt: 53, lastViewedAt: 5, isManuallyUnread: false, unreadCount: 1 },
    awaitingUserResponse: { reason: "choose" },
    origin: "shared",
    purpose: "workflow",
    conversationPartnerIds: ["peer-a"],
    legacyAvatarPath: "legacy-avatar.png",
  });
});

test("DB extras use directory identity and zero creation time when stored values are empty", () => {
  const value = readDbExtras(makeDb({ values: { agentId: "", createdAt: "" } }), "directory-id");
  assert.equal(value?.agentId, "directory-id");
  assert.equal(value?.createdAt, 0);
  assert.equal(value?.updatedAt, 0);
  assert.equal(readDbExtras(makeDb({ values: { createdAt: Number.NaN } }), "directory-id")?.createdAt, 0);
});

test("DB extras default optional metadata and empty transcript projections", () => {
  const value = readDbExtras(makeDb({ unread: { lastActivityAt: 8, lastViewedAt: 7, isManuallyUnread: false, unreadCount: 0 } }), "directory-id");
  assert.equal(value?.hasTranscript, false);
  assert.equal(value?.lastEntry, null);
  assert.equal(value?.lastMessage, null);
  assert.equal(value?.newestEntryId, null);
  assert.deepEqual([value?.awaitingUserResponse, value?.origin, value?.purpose, value?.conversationPartnerIds, value?.legacyAvatarPath], [null, "user", null, [], null]);
});

test("an unread-state or transcript read error degrades DB extras to null", () => {
  assert.equal(readDbExtras(makeDb({ failEntries: true }), "agent-a"), null);
  const brokenUnread = { ...makeDb() } as FakeDb;
  brokenUnread.getUnreadState = () => { throw new Error("database closed"); };
  assert.equal(readDbExtras(brokenUnread, "agent-a"), null);
});

test("loading DB extras creates a missing profile from database identity and retains the legacy avatar path", async () => {
  await withAgentDir(async (agentDir, dbPath) => {
    const db = makeDb({
      values: { name: "  Slate Helper  " },
      profile: { description: "  explains work  ", avatarPath: "old-avatar.png" },
    });
    const value = loadAgentDbExtras(db, dbPath, "agent-a");
    assert.ok(value);
    const profile = readSlateProfileFile(getSlateProfilePath(agentDir));
    assert.deepEqual(profile, { name: "Slate Helper", description: "explains work", title: "", avatarShape: "", avatarColor: "" });
    assert.equal(value.legacyAvatarPath, "old-avatar.png");
  });
});

test("loading DB extras does not replace a profile that already exists", async () => {
  await withAgentDir(async (agentDir, dbPath) => {
    writeSlateProfileFile(getSlateProfilePath(agentDir), { name: "Existing", description: "kept", title: "", avatarShape: "", avatarColor: "" });
    const value = loadAgentDbExtras(makeDb({ values: { name: "Different" } }), dbPath, "agent-a");
    assert.equal(value?.agentId, "agent-db");
    assert.equal(readSlateProfileFile(getSlateProfilePath(agentDir))?.name, "Existing");
  });
});

test("a minimal agent summary reads profile identity and floors filesystem time", async () => {
  await withAgentDir(async (agentDir, dbPath) => {
    writeSlateProfileFile(getSlateProfilePath(agentDir), { name: "Ada", description: "Builds tools", title: "Guide", avatarShape: "round", avatarColor: "blue" });
    assert.deepEqual(minimalAgentSummary({ dirName: "agent-a", dbPath, dbStats: { mtimeMs: 99.9 }, activeAgentId: "agent-a" }), {
      id: "agent-a",
      name: "Ada",
      description: "Builds tools",
      title: "Guide",
      avatarDataUrl: null,
      avatarVersion: null,
      avatarShape: "round",
      avatarColor: "blue",
      createdAt: 99,
      updatedAt: 99,
      path: dbPath,
      isActive: true,
      isRunning: false,
      isComposingMessage: false,
      lastEntry: null,
      lastMessageId: null,
      lastMessagePreview: null,
      newestEntryId: null,
      hasUnread: false,
      unreadCount: 0,
      lastViewedAt: 0,
      lastActivityAt: 0,
      awaitingUserResponse: null,
      notificationsEnabled: false,
      notifyOnUpdatesEnabled: true,
      isHiddenFromSidebar: false,
      origin: "user",
      isGroup: false,
      memberIds: [],
      conversationPartnerIds: [],
    });
  });
});

test("a missing or blank profile gives a Slate identity and zero fallback timestamp", async () => {
  await withAgentDir(async (_agentDir, dbPath) => {
    const value = minimalAgentSummary({ dirName: "agent-a", dbPath, dbStats: { mtimeMs: 0.8 }, activeAgentId: "elsewhere" });
    assert.deepEqual([value.name, value.description, value.title, value.createdAt, value.updatedAt, value.isActive], ["Slate", "", "", 0, 0, false]);
    assert.deepEqual([value.avatarShape, value.avatarColor], [null, null]);
  });
});

test("empty avatar attributes are omitted as null in a minimal row", async () => {
  await withAgentDir(async (agentDir, dbPath) => {
    writeSlateProfileFile(getSlateProfilePath(agentDir), { name: "Ada", description: "", title: "", avatarShape: "", avatarColor: "" });
    const value = minimalAgentSummary({ dirName: "agent-a", dbPath });
    assert.deepEqual([value.name, value.avatarShape, value.avatarColor], ["Ada", null, null]);
  });
});

test("quarantined store discovery only accepts the durable filename prefix", async () => {
  await withAgentDir(async (agentDir) => {
    assert.equal(await agentHasQuarantinedStoreDb(agentDir), false);
    writeFileSync(join(agentDir, "store.db.corrupt"), "x");
    assert.equal(await agentHasQuarantinedStoreDb(agentDir), false);
    writeFileSync(join(agentDir, "store.db.corrupt-1700"), "x");
    assert.equal(await agentHasQuarantinedStoreDb(agentDir), true);
    const regularFile = join(agentDir, "regular-file");
    writeFileSync(regularFile, "x");
    assert.equal(await agentHasQuarantinedStoreDb(regularFile), false);
  });
});

test("a quarantined store short-circuits other durable-footprint probes", async () => {
  await withAgentDir(async (agentDir) => {
    writeFileSync(join(agentDir, "store.db.corrupt-1"), "x");
    const calls: string[] = [];
    assert.equal(await agentHasDurableFootprint(agentDir, () => { calls.push("memory"); return true; }, () => { calls.push("automation"); return true; }, () => { calls.push("workflow"); return true; }), true);
    assert.deepEqual(calls, []);
  });
});

test("durable-footprint probes short-circuit in memory, automation, workflow order", async () => {
  await withAgentDir(async (agentDir) => {
    const calls: string[] = [];
    assert.equal(await agentHasDurableFootprint(agentDir, () => { calls.push("memory"); return false; }, () => { calls.push("automation"); return true; }, () => { calls.push("workflow"); return true; }), true);
    assert.deepEqual(calls, ["memory", "automation"]);
    calls.length = 0;
    assert.equal(await agentHasDurableFootprint(agentDir, () => { calls.push("memory"); return false; }, () => { calls.push("automation"); return false; }, () => { calls.push("workflow"); return true; }), true);
    assert.deepEqual(calls, ["memory", "automation", "workflow"]);
    calls.length = 0;
    assert.equal(await agentHasDurableFootprint(agentDir, () => { calls.push("memory"); return false; }), false);
    assert.deepEqual(calls, ["memory"]);
  });
});

test("building a summary creates default settings and still returns degraded extras-free state", async () => {
  await withAgentDir(async (agentDir, dbPath) => {
    const value = await buildSummary({ dbPath, dirName: "agent-a", dbStats: { mtimeMs: 72.9 }, activeAgentId: "agent-a", includeBlank: false });
    assert.ok(value);
    assert.equal(existsSync(getSlateSettingsPath(agentDir)), true);
    assert.deepEqual(agentSettingsAt(getSlateSettingsPath(agentDir)), { notifyOnAgentUpdates: true, hiddenFromSidebar: false });
    assert.deepEqual([value.id, value.name, value.createdAt, value.updatedAt, value.isActive, value.hasUnread], ["agent-a", "Slate", 72, 72, true, false]);
  });
});

test("blank transcript summaries are filtered unless identity, activity, inclusion or durable state keeps them", async () => {
  await withAgentDir(async (agentDir, dbPath) => {
    const blank = extras({ hasTranscript: false, unreadState: { lastActivityAt: 0, lastViewedAt: 0, isManuallyUnread: false, unreadCount: 0 } });
    const memoryCalls: string[] = [];
    assert.equal(await buildSummary({ extras: blank, dbPath, dirName: "agent-a", includeBlank: false, agentHasMemory: (dir) => { memoryCalls.push(dir); return false; } }), null);
    assert.deepEqual(memoryCalls, [agentDir]);
    assert.ok(await buildSummary({ extras: extras({ ...blank, hasTranscript: true }), dbPath, dirName: "agent-a", includeBlank: false }));
    assert.ok(await buildSummary({ extras: blank, dbPath, dirName: "agent-a", activeAgentId: "agent-a", includeBlank: false }));
    assert.ok(await buildSummary({ extras: blank, dbPath, dirName: "agent-a", includeBlank: true }));
    assert.ok(await buildSummary({ extras: blank, dbPath, dirName: "agent-a", includeBlank: false, agentHasMemory: () => true }));

    writeSlateProfileFile(getSlateProfilePath(agentDir), { name: "Slate", description: "", title: "A titled agent", avatarShape: "", avatarColor: "" });
    assert.ok(await buildSummary({ extras: blank, dbPath, dirName: "agent-a", includeBlank: false }));
  });
});

test("group identity keeps a blank transcript summary visible", async () => {
  await withAgentDir(async (_agentDir, dbPath) => {
    const value = await buildSummary({
      extras: extras({ hasTranscript: false, unreadState: { lastActivityAt: 0, lastViewedAt: 0, isManuallyUnread: false, unreadCount: 0 } }),
      dbPath,
      dirName: "group-agent",
      includeBlank: false,
      isGroup: true,
    });
    assert.equal(value?.isGroup, true);
  });
});

test("a summary combines stored metadata, settings, unread state, avatar and room fields", async () => {
  await withAgentDir(async (agentDir, dbPath) => {
    writeSlateProfileFile(getSlateProfilePath(agentDir), { name: "Ada", description: "Builder", title: "Guide", avatarShape: "round", avatarColor: "blue" });
    writeAgentSettings(getSlateSettingsPath(agentDir), { notifyOnAgentUpdates: false, hiddenFromSidebar: true });
    const avatarCalls: Array<[string, string | null]> = [];
    const remoteRoom = { id: "room-1", label: "Shared" };
    const value = await buildSummary({
      extras: extras({
        agentId: "db-agent",
        createdAt: 14,
        updatedAt: 80,
        lastEntry: { kind: "link", url: "https://example.test" },
        lastMessage: { id: "message-8", preview: "Finished" },
        newestEntryId: "entry-9",
        unreadState: { lastActivityAt: 80, lastViewedAt: 50, isManuallyUnread: false, unreadCount: 4 },
        awaitingUserResponse: { reason: "confirm" },
        origin: "room",
        purpose: "workflow",
        conversationPartnerIds: ["peer-a", "peer-b"],
        legacyAvatarPath: "legacy.png",
      }),
      dbPath,
      dirName: "folder-id",
      activeAgentId: "folder-id",
      dbStats: { mtimeMs: 90.8 },
      includeBlank: false,
      readAvatar: async (dir, legacy) => { avatarCalls.push([dir, legacy]); return { dataUrl: "data:image/png;base64,AA==", version: "v2" }; },
      isGroup: true,
      memberIds: ["peer-a", "peer-b"],
      remoteRoom,
    });
    assert.deepEqual(avatarCalls, [[agentDir, "legacy.png"]]);
    assert.deepEqual([
      value?.id, value?.name, value?.description, value?.title, value?.createdAt, value?.updatedAt,
      value?.isActive, value?.avatarDataUrl, value?.avatarVersion, value?.lastEntry, value?.lastMessageId,
      value?.lastMessagePreview, value?.newestEntryId, value?.hasUnread, value?.unreadCount,
      value?.lastViewedAt, value?.lastActivityAt, value?.awaitingUserResponse,
      value?.notificationsEnabled, value?.notifyOnUpdatesEnabled, value?.isHiddenFromSidebar,
      value?.origin, value?.purpose, value?.isGroup, value?.memberIds, value?.remoteRoom, value?.conversationPartnerIds,
    ], [
      "db-agent", "Ada", "Builder", "Guide", 14, 80,
      true, "data:image/png;base64,AA==", "v2", { kind: "link", url: "https://example.test" }, "message-8",
      "Finished", "entry-9", true, 4,
      50, 80, { reason: "confirm" },
      false, false, true,
      "room", "workflow", true, ["peer-a", "peer-b"], remoteRoom, ["peer-a", "peer-b"],
    ]);
  });
});

test("unread summaries require activity or a manual flag and never expose zero unread count", async () => {
  await withAgentDir(async (_agentDir, dbPath) => {
    const manual = await buildSummary({ extras: extras({ unreadState: { lastActivityAt: 30, lastViewedAt: 30, isManuallyUnread: true, unreadCount: 0 } }), dbPath, dirName: "manual", includeBlank: false });
    assert.deepEqual([manual?.hasUnread, manual?.unreadCount], [true, 1]);
    const activity = await buildSummary({ extras: extras({ unreadState: { lastActivityAt: 31, lastViewedAt: 30, isManuallyUnread: false, unreadCount: 5 } }), dbPath, dirName: "activity", includeBlank: false });
    assert.deepEqual([activity?.hasUnread, activity?.unreadCount], [true, 5]);
    const read = await buildSummary({ extras: extras({ unreadState: { lastActivityAt: 30, lastViewedAt: 30, isManuallyUnread: false, unreadCount: 5 } }), dbPath, dirName: "read", includeBlank: false });
    assert.deepEqual([read?.hasUnread, read?.unreadCount], [false, 0]);
  });
});

test("optional purpose and remote-room fields stay absent when they were not supplied", async () => {
  await withAgentDir(async (_agentDir, dbPath) => {
    const value = await buildSummary({ extras: extras({ purpose: null, origin: null }), dbPath, dirName: "agent-a", includeBlank: false, remoteRoom: null });
    assert.equal("purpose" in (value ?? {}), false);
    assert.equal("remoteRoom" in (value ?? {}), false);
    assert.deepEqual([value?.isGroup, value?.memberIds, value?.conversationPartnerIds, value?.origin], [false, [], [], "user"]);
  });
});

test("durable footprint keeps a transcript-free summary and settings keep their independent defaults", async () => {
  await withAgentDir(async (agentDir, dbPath) => {
    const value = await buildSummary({
      extras: extras({ hasTranscript: false, unreadState: { lastActivityAt: 0, lastViewedAt: 0, isManuallyUnread: false, unreadCount: 0 } }),
      dbPath,
      dirName: "agent-a",
      includeBlank: false,
      agentHasMemory: (dir) => dir === agentDir,
    });
    assert.ok(value);
    assert.deepEqual(agentSettingsAt(getSlateSettingsPath(agentDir)), { notifyOnAgentUpdates: true, hiddenFromSidebar: false });
  });
});
