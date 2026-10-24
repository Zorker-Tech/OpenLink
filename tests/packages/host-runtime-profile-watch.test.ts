/**
 * Noticing that a conversation's own files changed: what a name change is worth saying, which files are watched, and what
 * one change turns into.
 */

import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";

import { getAgentMemoryDir } from "../../source/host/memory/memory-service.ts";
import { ProfileWatch, PROFILE_WATCH_DEBOUNCE_MS } from "../../source/host/transcript/profile-watch.ts";
import { SLATE_DEFAULT_AGENT_NAME } from "../../source/shared/agents/agents.ts";

const until = (ms = 120) => new Promise((resolve) => { setTimeout(resolve, ms); });

/** A clock the test moves itself, so a coalesced emit happens when the test says so. */
function testClock() {
  const scheduled: Array<{ at: number; callback: () => void; disposed: boolean }> = [];
  let now = 1_000;
  return {
    clock: { now: () => now, monotonicNow: () => now, schedule(delayMs: number, callback: () => void) { const entry = { at: now + delayMs, callback, disposed: false }; scheduled.push(entry); return { dispose() { entry.disposed = true; } }; } },
    scheduled,
    runDue() { const due = scheduled.filter((entry) => !entry.disposed); for (const entry of due) { entry.disposed = true; entry.callback(); } return due.length; },
  };
}

/** A transcript manager as the profile watch uses one, over a real directory. */
function harness() {
  const root = mkdtempSync(join(tmpdir(), "slate-profile-watch-"));
  const calls: unknown[][] = [];
  const timeline: unknown[][] = [];
  const profiles = new Map<string, { name: string; description?: string }>();
  const { clock, scheduled, runDue } = testClock();
  const dirOf = (agentId: string) => join(root, agentId);
  const manager = {
    clock,
    sessionStore: {
      getAgentProfileText: (agentId: string) => profiles.get(agentId) ?? null,
      getAgentDir: (agentId: string) => dirOf(agentId),
    },
    sessions: { activeSession: undefined as unknown, liveSessions: new Map<string, unknown>() },
    emitTimelineEvent: (agentId: string, event: unknown) => { timeline.push([agentId, event]); },
  };
  const rosterEmit = {
    emitAgents: async () => { calls.push(["emit-agents"]); },
    emitAgentUpdate: async (agentId: string) => { calls.push(["emit-update", agentId]); },
  };
  const watch = new ProfileWatch(manager as never, new EventEmitter(), rosterEmit as never);
  return { watch, manager, calls, timeline, profiles, root, dirOf, scheduled, runDue, kinds: (of: string) => calls.filter((call) => call[0] === of) };
}

/** Write a profile file the watch can read, and give the agent a directory to live in. */
function writeProfile(root: string, agentId: string, profile: Record<string, unknown>): string {
  const dir = join(root, agentId);
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, "profile.json"), JSON.stringify(profile, null, 2), "utf8");
  return dir;
}

describe("noticing that a conversation's files changed", () => {
  it("says when a name changed, and only then", () => {
    const { watch, timeline, profiles } = harness();
    assert.equal(PROFILE_WATCH_DEBOUNCE_MS, 50);
    // The first sighting of a name is not a change, and the name it remembers is trimmed.
    profiles.set("agent-1", { name: "  Notes  " });
    watch.recordNameChangeEvent("agent-1");
    assert.equal(watch.lastKnownAgentNames.get("agent-1"), "Notes");
    assert.deepEqual(timeline, []);
    // The same name again, in any spelling, is not a change either.
    watch.recordNameChangeEvent("agent-1");
    profiles.set("agent-1", { name: "Notes" });
    watch.recordNameChangeEvent("agent-1");
    assert.deepEqual(timeline, []);
    // A different name is worth saying, with both sides of it.
    profiles.set("agent-1", { name: "Notebook" });
    watch.recordNameChangeEvent("agent-1");
    assert.deepEqual(timeline, [["agent-1", { type: "name-changed", from: "Notes", to: "Notebook" }]]);
    assert.equal(watch.lastKnownAgentNames.get("agent-1"), "Notebook");
    // An agent with no name yet is not something to remember or to say.
    profiles.set("agent-2", { name: "   " });
    watch.recordNameChangeEvent("agent-2");
    assert.equal(watch.lastKnownAgentNames.has("agent-2"), false);
    assert.equal(timeline.length, 1);
  });

  it("remembers a name it sees without saying anything, and never overwrites what it knows", () => {
    const { watch, profiles, timeline } = harness();
    profiles.set("agent-1", { name: "Notes" });
    watch.seedKnownAgentName("agent-1");
    assert.equal(watch.lastKnownAgentNames.get("agent-1"), "Notes");
    assert.deepEqual(timeline, []);
    // What is already known is not replaced by what is read now.
    profiles.set("agent-1", { name: "Something else" });
    watch.seedKnownAgentName("agent-1");
    assert.equal(watch.lastKnownAgentNames.get("agent-1"), "Notes");
    // An agent the platform knows nothing about is not remembered at all.
    watch.seedKnownAgentName("agent-2");
    assert.equal(watch.lastKnownAgentNames.has("agent-2"), false);
  });

  it("tells whoever is listening that a profile changed", () => {
    const { watch } = harness();
    const heard: string[] = [];
    const unsubscribe = watch.subscribeProfileChanged((event) => { heard.push(event.agentId); });
    watch.emitProfileChanged("agent-1");
    assert.deepEqual(heard, ["agent-1"]);
    unsubscribe();
    watch.emitProfileChanged("agent-2");
    assert.deepEqual(heard, ["agent-1"]);
  });

  it("watches a conversation, remembers the name it is under, and forgets it when it is told to stop", () => {
    const { watch, root, profiles, manager, runDue, scheduled, calls, timeline } = harness();
    const dir = writeProfile(root, "agent-1", { name: "Notes" });
    profiles.set("agent-1", { name: "Notes" });
    const session = { id: "agent-1", dbPath: join(dir, "db") };
    try {
      watch.watchSessionProfile(session);
    // Watching a conversation remembers the name it is under, and watching it again changes nothing.
    assert.equal(watch.lastKnownAgentNames.get("agent-1"), "Notes");
    watch.watchSessionProfile(session);
    assert.equal(watch.lastKnownAgentNames.get("agent-1"), "Notes");
    // One change beside the conversation becomes one roster update and one announcement, however many files changed.
    manager.sessions.activeSession = { id: "agent-1", dbPath: session.dbPath };
    writeFileSync(join(dir, "avatar.png"), "not really a picture", "utf8");
    watch.scheduleProfileEmit();
    watch.scheduleProfileEmit();
    assert.equal(scheduled.filter((entry) => !entry.disposed).length, 1);
    runDue();
    assert.deepEqual(calls.map((call) => call[0]), ["emit-update"]);
    assert.deepEqual(calls[0]?.[1], "agent-1");
    // Something else changed the name while the files were being watched.
    profiles.set("agent-1", { name: "Notebook" });
    watch.scheduleProfileEmit();
    runDue();
    assert.deepEqual(timeline, [["agent-1", { type: "name-changed", from: "Notes", to: "Notebook" }]]);
    } finally {
      // Whatever happened, the directory stops being watched.
      watch.stopWatchingProfile();
    }
    // Stopping stops the watching; what was learned about the names stays learned.
    assert.equal(watch.lastKnownAgentNames.size, 1);
    assert.equal(watch.lastKnownAgentNames.get("agent-1"), "Notebook");
  });

  it("forgets the conversation it watched when told to stop", async () => {
    const { watch, calls, runDue, root, profiles } = harness();
    const dir = writeProfile(root, "agent-1", { name: "Notes" });
    profiles.set("agent-1", { name: "Notes" });
    watch.watchSessionProfile({ id: "agent-1", dbPath: join(dir, "db") });
    watch.stopWatchingProfile();
    watch.scheduleProfileEmit();
    runDue();
    await until(20);
    assert.deepEqual(calls.map((call) => call[0]), ["emit-agents"]);
  });

  it("asks for the whole roster when there is no conversation to update", async () => {
    const { watch, calls, runDue } = harness();
    watch.scheduleProfileEmit();
    runDue();
    await until(20);
    assert.deepEqual(calls.map((call) => call[0]), ["emit-agents"]);
    // A second ask while one is waiting is the same ask.
    const { watch: coalescing, calls: coalescingCalls, runDue: runCoalescing, scheduled } = harness();
    coalescing.scheduleProfileEmit();
    coalescing.scheduleProfileEmit();
    assert.equal(scheduled.filter((entry) => !entry.disposed).length, 1);
    runCoalescing();
    await until(20);
    assert.deepEqual(coalescingCalls.map((call) => call[0]), ["emit-agents"]);
  });

  it("says what an agent's profile is, and where its files are", async () => {
    const { watch, root, dirOf } = harness();
    // An agent that is not there has no profile to show.
    assert.equal(await watch.getAgentDisplayProfile("nothing"), null);
    const dir = writeProfile(root, "agent-1", { name: "  Notes  ", description: "keeps notes" });
    assert.deepEqual(await watch.getAgentDisplayProfile("agent-1"), { name: "Notes", description: "keeps notes" });
    // An agent that has no name of its own answers with the platform's own name for it.
    writeProfile(root, "agent-2", { description: "no name yet" });
    assert.deepEqual(await watch.getAgentDisplayProfile("agent-2"), { name: SLATE_DEFAULT_AGENT_NAME, description: "no name yet" });
    // Where the profile and the settings of a conversation live is resolved from its database.
    const resolved = watch.resolveAgentProfile({ dbPath: join(dir, "db") });
    assert.deepEqual({ name: resolved.name, description: resolved.description, profile: resolved.filePath, settings: resolved.settingsFilePath }, { name: "Notes", description: "keeps notes", profile: join(dir, "profile.json"), settings: join(dir, "settings.json") });
    assert.equal(dirOf("agent-1").endsWith("agent-1"), true);
    assert.equal(getAgentMemoryDir(dir).endsWith("memory"), true);
  });
});
