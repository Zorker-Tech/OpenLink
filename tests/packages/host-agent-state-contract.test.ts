import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { describe, it } from "node:test";
import { FileMemoryStore, getProjectDir, getProjectMemoryShardDir, getUserMemoryShardDir, projectDirExists } from "../../source/host/memory/memory-service.ts";
import { AVATAR_MAX_BYTES, createSlateAgentState, MEMORY_NOTE_PREFIX, type AgentStateDeps } from "../../source/host/memory/agent-state.ts";
import { normalizeMemoryContent } from "../../source/host/runner/slate-memory.ts";
import { CANONICAL_AVATAR_FILENAME } from "../../source/host/agents/agent-avatar.ts";

interface Harness {
  state: ReturnType<typeof createSlateAgentState>;
  slateRoot: string;
  agentDir: string;
  calls: {
    memoryAdds: Array<{ content: string; kind: string; at: number }>;
    memoryRemovals: string[];
    automationCreates: unknown[];
    automationUpdates: Array<[string, unknown]>;
    automationEnabled: Array<[string, boolean]>;
    workflowCreates: unknown[];
    workflowUpdates: Array<[string, unknown]>;
    workflowDeletes: string[];
    channels: string[];
    profiles: Array<Record<string, string>>;
    settings: Array<Record<string, boolean>>;
    avatarChanges: number;
    boxReads: string[];
    addedMemory: boolean;
  };
  setProfile(profile: Record<string, string> | null): void;
}

function harness(): Harness {
  const slateRoot = mkdtempSync(join(tmpdir(), "slate-agent-state-contract-"));
  const agentDir = join(slateRoot, "agents", "agent-a");
  mkdirSync(agentDir, { recursive: true });
  const calls: Harness["calls"] = {
    memoryAdds: [], memoryRemovals: [], automationCreates: [], automationUpdates: [], automationEnabled: [],
    workflowCreates: [], workflowUpdates: [], workflowDeletes: [], channels: [], profiles: [], settings: [],
    avatarChanges: 0, boxReads: [], addedMemory: true,
  };
  let profile: Record<string, string> | null = null;
  const joinedProjects = new Set<string>(["notes"]);
  const deps: AgentStateDeps = {
    agentId: "agent-a",
    agentDir,
    slateRoot,
    memory: {
      addMemory(content, at, kind) {
        calls.memoryAdds.push({ content, at, kind });
        return calls.addedMemory ? { content: normalizeMemoryContent(content) } : null;
      },
      removeMemoryByContent(content) { calls.memoryRemovals.push(content); return content === "saved fact" || content === `${MEMORY_NOTE_PREFIX}a note`; },
    },
    membership: {
      read: () => joinedProjects,
      join: slug => { joinedProjects.add(slug); return true; },
      leave: slug => joinedProjects.delete(slug),
    },
    channels: { remove: platform => { calls.channels.push(platform); return platform === "slack"; } },
    automations: {
      upsert(spec) { calls.automationCreates.push(spec); return { id: "routine-a", name: "Daily", isEnabled: true, trigger: { type: "cron", schedule: "0 9 * * *" } as never }; },
      update(id, spec) { calls.automationUpdates.push([id, spec]); return id === "routine-a" ? { id, name: "Daily", isEnabled: false, trigger: { type: "cron", schedule: "0 9 * * *" } as never } : null; },
      setEnabled(id, enabled) { calls.automationEnabled.push([id, enabled]); return id === "routine-a" ? { id, name: "Daily" } : null; },
      get(id) { return id === "routine-a" ? { name: "Daily" } : null; },
      remove(id) { return id === "routine-a"; },
    },
    workflows: {
      create(spec) { calls.workflowCreates.push(spec); return { id: "workflow-a", name: "Release Notes" }; },
      update(id, spec) { calls.workflowUpdates.push([id, spec]); return id === "workflow-a" ? { id, name: "Release Notes" } : null; },
      remove(id) { calls.workflowDeletes.push(id); return id === "workflow-a"; },
    },
    now: () => 42,
    readProfile: () => profile,
    writeProfile(value) { calls.profiles.push(value); profile = value; },
    writeSettings(value) { calls.settings.push(value); },
    onAvatarChanged() { calls.avatarChanges += 1; },
    async readBoxFile(path) { calls.boxReads.push(path); return pngBytes; },
  };
  const state = createSlateAgentState(deps);
  return { state, slateRoot, agentDir, calls, setProfile: value => { profile = value; } };
}

const pngBytes = Uint8Array.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x01]);
const memoryDebounce = { name: "test-memory", wrap: (fn: (...args: never[]) => void) => Object.assign(fn, { dispose() {} }) } as never;

describe("agent self-state contract", () => {
  it("keeps the memory-note marker and avatar limit bounded", () => {
    assert.equal(MEMORY_NOTE_PREFIX, "Note: ");
    assert.equal(AVATAR_MAX_BYTES, 5 * 1024 * 1024);
  });

  it("writes profile, note and log memories with their own stored kinds", async () => {
    const h = harness();
    assert.deepEqual(await h.state.writeMemory({ content: "  profile fact  ", tier: "profile" }), { ok: true, message: "Remembered in your memory (profile): profile fact" });
    assert.deepEqual(await h.state.writeMemory({ content: "  a note  ", tier: "note" }), { ok: true, message: "Remembered in your memory (note): Note: a note" });
    assert.deepEqual(await h.state.writeMemory({ content: "log fact", tier: "log" }), { ok: true, message: "Remembered in your memory (log): log fact" });
    assert.deepEqual(h.calls.memoryAdds, [
      { content: "  profile fact  ", kind: "profile", at: 42 },
      { content: "Note: a note", kind: "log", at: 42 },
      { content: "log fact", kind: "log", at: 42 },
    ]);
    h.calls.addedMemory = false;
    assert.match((await h.state.writeMemory({ content: "", tier: "profile" })).message, /nothing was saved/);
  });

  it("removes exactly the requested memory text and distinguishes missing facts", async () => {
    const h = harness();
    assert.deepEqual(await h.state.removeMemory({ content: "saved fact" }), { ok: true, message: "Forgot from your memory: saved fact" });
    assert.deepEqual(await h.state.removeMemory({ content: "unknown" }), { ok: false, message: "no fact with exactly that text is recorded in your memory. Read or grep the folder for the exact wording first." });
    assert.deepEqual(h.calls.memoryRemovals, ["saved fact", "unknown"]);
  });

  it("writes shared user memory into the agent's user shard", async t => {
    const h = harness();
    t.after(() => rmSync(h.slateRoot, { recursive: true, force: true }));
    const result = await h.state.writeMemory({ content: "shared fact", tier: "log", scope: "user" });
    assert.equal(result.ok, true);
    const shard = getUserMemoryShardDir(h.slateRoot, "agent-a");
    assert.equal(existsSync(shard), true);
    assert.equal(new FileMemoryStore(shard, memoryDebounce).recall().recent[0]?.content, "shared fact");
  });

  it("requires a safe, existing, joined project before writing project memory", async t => {
    const h = harness();
    t.after(() => rmSync(h.slateRoot, { recursive: true, force: true }));
    assert.match((await h.state.writeMemory({ content: "x", tier: "log", scope: "project" })).message, /project.*slug.*required/);
    assert.match((await h.state.writeMemory({ content: "x", tier: "log", scope: "project", project: "../escape" })).message, /not a valid project slug/);
    assert.match((await h.state.writeMemory({ content: "x", tier: "log", scope: "project", project: "notes" })).message, /no project/);
    mkdirSync(getProjectDir(h.slateRoot, "notes"), { recursive: true });
    assert.equal((await h.state.writeMemory({ content: "project fact", tier: "log", scope: "project", project: "notes" })).ok, true);
    const shard = getProjectMemoryShardDir(h.slateRoot, "notes", "agent-a");
    assert.equal(new FileMemoryStore(shard, memoryDebounce).recall().recent[0]?.content, "project fact");
  });

  it("creates routines and names update, pause, resume, delete, and missing outcomes", async () => {
    const h = harness();
    const created = await h.state.createAutomation({ spec: { name: "Daily" } });
    assert.match(created.message, /^Saved routine "Daily" \(folder routine-a\) — /);
    assert.match((await h.state.updateAutomation({ id: "routine-a", spec: { prompt: "new" } })).message, /^Updated routine "Daily" \(folder routine-a\) — .+, paused\.$/);
    assert.equal((await h.state.updateAutomation({ id: "missing", spec: {} })).ok, false);
    assert.equal((await h.state.setAutomationEnabled({ id: "routine-a", isEnabled: false })).message, 'Paused routine "Daily" (folder routine-a).');
    assert.equal((await h.state.setAutomationEnabled({ id: "missing", isEnabled: true })).ok, false);
    assert.equal((await h.state.deleteAutomation({ id: "routine-a" })).message, 'Deleted routine "Daily" (folder routine-a).');
    assert.equal((await h.state.deleteAutomation({ id: "missing" })).ok, false);
    assert.deepEqual(h.calls.automationCreates, [{ name: "Daily" }]);
  });

  it("saves and edits workflows while refusing platform-managed workflows", async () => {
    const h = harness();
    assert.deepEqual(await h.state.writeWorkflow({ name: "Release Notes", body: "steps" }), { ok: true, message: 'Saved workflow "Release Notes" (id workflow-a).' });
    assert.equal((await h.state.writeWorkflow({ id: "workflow-a", name: "Release Notes", body: "updated" })).ok, true);
    assert.equal((await h.state.writeWorkflow({ id: "missing", name: "x", body: "y" })).message, 'no workflow with id "missing" exists, or the new fields were invalid. Platform-managed skills cannot be edited.');
    assert.equal((await h.state.deleteWorkflow({ id: "workflow-a" })).message, "Deleted workflow workflow-a.");
    assert.equal((await h.state.deleteWorkflow({ id: "missing" })).message, 'no workflow with id "missing" exists, or it is a platform-managed skill, which cannot be deleted.');
    assert.deepEqual(h.calls.workflowCreates, [{ name: "Release Notes", description: "", body: "steps", trigger: null }]);
  });

  it("merges profile updates, trims values, and rejects empty requests", async () => {
    const h = harness();
    h.setProfile({ name: "Old", pronouns: "they" });
    assert.equal((await h.state.updateProfile({ name: "  New  " })).message, "Updated your name.");
    assert.deepEqual(h.calls.profiles.at(-1), { name: "New", pronouns: "they" });
    assert.equal((await h.state.updateProfile({ description: "  About  " })).message, "Updated your description.");
    assert.deepEqual(h.calls.profiles.at(-1), { name: "New", pronouns: "they", description: "About" });
    assert.equal((await h.state.updateProfile({})).ok, false);
    assert.equal((await h.state.updateProfile({ name: "  " })).ok, false);
  });

  it("updates only supplied settings and refuses an empty update", async () => {
    const h = harness();
    assert.equal((await h.state.updateSettings({ hiddenFromSidebar: true })).message, "Updated your settings: hiddenFromSidebar.");
    assert.deepEqual(h.calls.settings, [{ hiddenFromSidebar: true }]);
    assert.equal((await h.state.updateSettings({})).ok, false);
  });

  it("disconnects a connected channel and distinguishes one that is absent", async () => {
    const h = harness();
    assert.match((await h.state.disconnectChannel({ platform: "slack" })).message, /^Disconnected slack/);
    assert.deepEqual(await h.state.disconnectChannel({ platform: "matrix" }), { ok: false, message: "matrix is not connected." });
    assert.deepEqual(h.calls.channels, ["slack", "matrix"]);
  });

  it("creates a project as a join and preserves its file when create is called again", async t => {
    const h = harness();
    t.after(() => rmSync(h.slateRoot, { recursive: true, force: true }));
    assert.equal((await h.state.createProject({ slug: "../bad", name: "Bad" })).ok, false);
    assert.equal((await h.state.createProject({ slug: "notes", name: "  " })).ok, false);
    assert.deepEqual(await h.state.createProject({ slug: "notes", name: "Notes", description: " Shared notes " }), { ok: true, message: 'Created and joined project "Notes" (folder notes).' });
    const projectFile = join(getProjectDir(h.slateRoot, "notes"), "project.md");
    const original = readFileSync(projectFile, "utf8");
    writeFileSync(projectFile, "keep this file");
    assert.match((await h.state.createProject({ slug: "notes", name: "Other" })).message, /Joined existing project/);
    assert.equal(readFileSync(projectFile, "utf8"), "keep this file");
    assert.match(original, /Shared notes/);
    assert.equal(projectDirExists(h.slateRoot, "notes"), true);
  });

  it("joins and leaves only existing safe projects", async t => {
    const h = harness();
    t.after(() => rmSync(h.slateRoot, { recursive: true, force: true }));
    mkdirSync(getProjectDir(h.slateRoot, "notes"), { recursive: true });
    assert.match((await h.state.joinProject({ slug: "../escape" })).message, /not a valid project slug/);
    assert.match((await h.state.joinProject({ slug: "missing" })).message, /no project/);
    assert.equal((await h.state.joinProject({ slug: "notes" })).ok, true);
    assert.equal((await h.state.leaveProject({ slug: "notes" })).ok, true);
    assert.equal((await h.state.leaveProject({ slug: "notes" })).ok, false);
  });

  it("reads a box-local image through the box port and installs its canonical name", async t => {
    const h = harness();
    t.after(() => rmSync(h.slateRoot, { recursive: true, force: true }));
    const old = join(h.agentDir, "avatar.jpg");
    writeFileSync(old, "old image");
    const result = await h.state.setAvatar({ path: "/home/box/picture.png" });
    assert.deepEqual(result, { ok: true, message: `Updated your picture (${CANONICAL_AVATAR_FILENAME}). Source picture.png can be deleted if you no longer need it.` });
    assert.deepEqual(h.calls.boxReads, ["/home/box/picture.png"]);
    assert.deepEqual(readFileSync(join(h.agentDir, CANONICAL_AVATAR_FILENAME)), Buffer.from(pngBytes));
    assert.equal(existsSync(old), false);
    assert.equal(h.calls.avatarChanges, 1);
  });

  it("rejects unreadable, non-image, empty, and oversized avatar inputs", async t => {
    const h = harness();
    t.after(() => rmSync(h.slateRoot, { recursive: true, force: true }));
    assert.equal((await h.state.setAvatar({ path: "  " })).ok, false);
    assert.match((await h.state.setAvatar({ path: join(h.agentDir, "missing.png") })).message, /could not read/);
    const text = join(h.agentDir, "notes.txt");
    writeFileSync(text, "not an image");
    assert.match((await h.state.setAvatar({ path: text })).message, /not a recognized image/);
    const empty = join(h.agentDir, "empty.png");
    writeFileSync(empty, "");
    assert.match((await h.state.setAvatar({ path: empty })).message, /under 5 MB and non-empty/);
    const huge = join(h.agentDir, "huge.png");
    writeFileSync(huge, Buffer.concat([Buffer.from(pngBytes), Buffer.alloc(AVATAR_MAX_BYTES)]));
    assert.match((await h.state.setAvatar({ path: huge })).message, /under 5 MB and non-empty/);
  });

  it("clears conventional avatar files and reports when the default is already active", async t => {
    const h = harness();
    t.after(() => rmSync(h.slateRoot, { recursive: true, force: true }));
    writeFileSync(join(h.agentDir, CANONICAL_AVATAR_FILENAME), pngBytes);
    writeFileSync(join(h.agentDir, "avatar.webp"), pngBytes);
    assert.equal((await h.state.clearAvatar()).message, "Cleared your picture — back to the default.");
    assert.equal(existsSync(join(h.agentDir, CANONICAL_AVATAR_FILENAME)), false);
    assert.equal(existsSync(join(h.agentDir, "avatar.webp")), false);
    assert.equal((await h.state.clearAvatar()).message, "you already have the default picture.");
  });
});
