import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, describe, it } from "node:test";

import {
  FileMemoryStore,
  MemoryService,
  ProjectMemoryStore,
  UserMemoryStore,
  agentMemoryHasContent,
  getAgentMemoryDir,
  getProjectDir,
  getProjectMemoryShardDir,
  getProjectMemoryShardsDir,
  getProjectsRootDir,
  getUserMemoryDir,
  getProjectMemoryShardsDir as unusedShards,
  getUserMemoryShardDir,
  getUserMemoryShardsDir,
  memoryIdFor,
  parseFacts,
  projectDirExists,
  serializeFactLine,
} from "../../source/host/memory/memory-service.ts";

const roots: string[] = [];
function freshRoot(): string {
  const root = mkdtempSync(join(tmpdir(), "memory-service-"));
  roots.push(root);
  return root;
}
after(() => { while (roots.length) rmSync(roots.pop()!, { recursive: true, force: true }); });
const debounce = { name: "test", wrap: (fn: (...args: unknown[]) => void) => { const wrapped = (...args: unknown[]) => fn(...args); wrapped.dispose = () => {}; return wrapped; } };
const store = (root: string) => new FileMemoryStore(join(root, "agent", "memory"), debounce as never);

describe("the file memory store", () => {
  it("adds facts once and reads them back", () => {
    const root = freshRoot();
    const memory = store(root);
    assert.equal(memory.countMemories(), 0);
    const added = memory.addMemory("Likes tea", 1_000, "profile");
    assert.deepEqual(added, { id: memoryIdFor("Likes tea"), content: "Likes tea", createdAt: 1_000, kind: "profile" });
    assert.equal(memory.addMemory("Likes tea", 2_000, "profile"), null);
    assert.equal(memory.addMemory("", 2_000, "profile"), null);
    assert.notEqual(memory.addMemory("Ran the tests", 3_000, "log"), null);
    assert.equal(memory.countMemories(), 2);
    const recalled = memory.recall();
    assert.deepEqual(recalled.profile.map((entry) => entry.content), ["Likes tea"]);
    assert.deepEqual(recalled.recent.map((entry) => entry.content), ["Ran the tests"]);
    assert.deepEqual(memory.listMemories().map((entry) => entry.kind), ["profile", "log"]);
    assert.equal(memory.hasMemories(), true);
  });

  it("removes by id and by content", () => {
    const root = freshRoot();
    const memory = store(root);
    memory.addMemory("One", 1_000, "log");
    memory.addMemory("Two", 2_000, "log");
    assert.equal(memory.removeMemory("missing"), false);
    assert.equal(memory.removeMemoryByContent("One"), true);
    assert.equal(memory.removeMemoryByContent("One"), false);
    assert.equal(memory.countMemories(), 1);
    assert.equal(memory.removeMemoryByContent("Two"), true);
    assert.equal(memory.countMemories(), 0);
  });

  it("keeps a temporal review deadline", () => {
    const root = freshRoot();
    const memory = store(root);
    assert.equal(memory.isTemporalReviewDue(1_000), true);
    memory.markTemporalReview(1_000);
    assert.equal(memory.isTemporalReviewDue(1_000), false);
    assert.equal(memory.isTemporalReviewDue(1_000 + 24 * 60 * 60 * 1_000), true);
  });

  it("clears all memories and their log", () => {
    const root = freshRoot();
    const memory = store(root);
    memory.addMemory("Kept", 1_000, "log");
    memory.clearMemories();
    assert.equal(memory.countMemories(), 0);
    assert.equal(memory.hasMemories(), false);
    assert.equal(existsSync(memory.logDir), false);
  });

  it("tracks origins and tombstones through synthesis", () => {
    const root = freshRoot();
    const events: unknown[] = [];
    const memory = new FileMemoryStore(join(root, "agent", "memory"), debounce as never, { isEnabled: () => true, record: (evidence) => events.push(evidence) });
    memory.addMemory("Explicit fact", 1_000, "log");
    const snapshot = memory.prepareSynthesis();
    assert.equal(snapshot.memories.length, 1);
    const committed = memory.applySynthesis(snapshot, [{ action: "create", content: "Synthesized fact", kind: "profile" }], 5_000);
    assert.equal(committed, "committed");
    assert.equal(memory.countMemories(), 2);
    const next = memory.prepareSynthesis();
    const explicitId = next.memories.find((entry) => entry.content === "Explicit fact")!.id;
    assert.equal(memory.applySynthesis(next, [{ action: "remove", id: explicitId }], 6_000), "invalid");
    const synthesizedId = next.memories.find((entry) => entry.content === "Synthesized fact")!.id;
    assert.equal(memory.applySynthesis(next, [{ action: "update", id: synthesizedId, content: "Changed", kind: "profile" }], 7_000), "committed");
    assert.equal(memory.countMemories(), 2);
    assert.equal(memory.applySynthesis(next, [], 8_000), "stale");
    assert.equal(events.length, 0);
    assert.equal(typeof memory.recordMemoryEvidence, "function");
    memory.recordMemoryEvidence?.({ evidence: true });
    assert.deepEqual(events, [{ evidence: true }]);
  });

  it("parses fact lines and detects agent content", () => {
    const parsed = parseFacts(serializeFactLine("First", 1_000), "log", "path", 5);
    assert.equal(parsed.length, 1);
    assert.equal(parsed[0]!.order, 5);
    assert.equal(parsed[0]!.origin, "legacy");
    const root = freshRoot();
    assert.equal(agentMemoryHasContent(root), false);
    mkdirSync(join(root, "memory", "log"), { recursive: true });
    writeFileSync(join(root, "memory", "log", "2024-01.md"), serializeFactLine("Something", 1_000));
    assert.equal(agentMemoryHasContent(root), true);
  });
});

describe("memory locations", () => {
  it("builds the agent, user and project paths", () => {
    assert.equal(getAgentMemoryDir("/agents/a"), "/agents/a/memory");
    assert.equal(getUserMemoryDir("/slate"), "/slate/user-memory");
    assert.equal(getUserMemoryShardDir("/slate", "agent-1"), "/slate/user-memory/agents/agent-1");
    assert.equal(getProjectsRootDir("/slate"), "/slate/projects");
    assert.equal(getProjectDir("/slate", "proj"), "/slate/projects/proj");
    assert.equal(getProjectMemoryShardDir("/slate", "proj", "agent-1"), "/slate/projects/proj/memory/agents/agent-1");
    assert.equal(projectDirExists("/slate", "proj"), false);
  });
});

describe("the user and project memory stores", () => {
  it("reads memories across shards", () => {
    const root = freshRoot();
    const shard = getUserMemoryShardDir(root, "agent-1");
    const memberStore = new FileMemoryStore(shard, debounce as never);
    memberStore.addMemory("User likes tea", 1_000, "profile");
    const userStore = new UserMemoryStore(root, "agent-2", (id) => "Name " + id, debounce as never);
    const recalled = userStore.recall();
    assert.equal(recalled.profile[0]!.content, "User likes tea");
    assert.equal(recalled.profile[0]!.agentName, "Name agent-1");
    assert.equal(userStore.getLocation(), getUserMemoryDir(root));
    assert.equal(userStore.getOwnShardLocation(), getUserMemoryShardDir(root, "agent-2"));

    const projectShard = getProjectMemoryShardDir(root, "proj", "agent-1");
    const projectFileStore = new FileMemoryStore(projectShard, debounce as never);
    projectFileStore.addMemory("Project fact", 2_000, "log");
    const projectStore = new ProjectMemoryStore(root, "agent-2", { read: () => ["proj"] } as never, (id) => "Name " + id, debounce as never);
    const projectMemories = projectStore.recall();
    assert.equal(projectMemories[0]!.memory.content, "Project fact");
    assert.equal(projectMemories.length, 1);
    assert.equal(projectStore.getLocation(), getProjectsRootDir(root));
  });
});

describe("the memory service", () => {
  it("creates stores, lists and notifies about changes", () => {
    const root = freshRoot();
    const agentsRoot = join(root, "agents");
    mkdirSync(join(agentsRoot, "agent-1"), { recursive: true });
    const service = new MemoryService({ slateRoot: root, agentsRootDir: agentsRoot, debounce: debounce as never });
    const changes: number[] = [];
    const unsubscribe = service.subscribe(() => changes.push(1));
    assert.equal(service.agentHasContent(join(agentsRoot, "agent-1")), false);
    const storeForAgent = service.createAgentStore(join(agentsRoot, "agent-1"));
    storeForAgent.addMemory("Service fact", 1_000, "log");
    assert.equal(service.agentHasContent(join(agentsRoot, "agent-1")), true);
    assert.equal(service.list({ agentId: "agent-1" }).length, 1);
    assert.equal(service.remove({ agentId: "agent-1", id: service.list({ agentId: "agent-1" })[0]!.id }), true);
    assert.equal(changes.length, 1);
    service.clear({ agentId: "agent-1" });
    assert.equal(changes.length, 2);
    service.setActiveAgent("agent-1");
    service.setActiveAgent("agent-1");
    assert.equal(changes.length, 3);
    assert.equal(service.synthesisTargetForAgent("missing"), null);
    assert.equal(service.listSynthesisTargets().length, 1);
    unsubscribe();
    service.dispose();
  });
});
