/**
 * What a workflow store combines, edits and migrates across the global library and local skill sources.
 */

import assert from "node:assert/strict";
import { afterEach, describe, it } from "node:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import type { WorkflowSpec } from "../../source/shared/workflow-model.ts";
import { writeManagedSkillsCache } from "../../source/host/extensions/managed-setup/managed-skills-cache.ts";
import { writePluginSkillsCache } from "../../source/host/skills/plugin-skills-cache.ts";
import {
  FileWorkflowStore,
  LEGACY_WORKFLOWS_DIRNAME,
  agentHasWorkflows,
  discoverLocalSkillFiles,
  readPluginSkillFileFacts,
} from "../../source/host/workflows/workflow-store.ts";
import { WORKFLOW_FILENAME } from "../../source/shared/workflow-model.ts";

const cleanups: Array<() => void> = [];
afterEach(() => {
  while (cleanups.length > 0) cleanups.pop()?.();
});

function world() {
  const root = mkdtempSync(join(tmpdir(), "slate-workflow-store-contract-"));
  const agentDir = join(root, "agents", "agent-a");
  const slateRoot = join(root, "slate");
  const globalDir = join(slateRoot, "workflows");
  mkdirSync(agentDir, { recursive: true });
  const store = new FileWorkflowStore(agentDir, globalDir, () => "UTC");
  cleanups.push(() => {
    store.library.dir.stopWatching();
    store.managedDirWatcher.stopWatching();
    store.pluginSkillsDirWatcher.stopWatching();
    store.automations.dir.stopWatching();
    rmSync(root, { recursive: true, force: true });
  });
  return { root, agentDir, slateRoot, globalDir, store };
}

function workflow(name: string, body = `Do ${name}`, extra: Partial<WorkflowSpec> = {}): WorkflowSpec {
  return { name, description: `About ${name}`, body, trigger: null, ...extra };
}

function addPluginSkill(current: ReturnType<typeof world>, options: { readonly id: string; readonly name?: string; readonly owner?: number | null }) {
  const directory = join(current.root, "plugins", options.id);
  mkdirSync(directory, { recursive: true });
  const filePath = join(directory, WORKFLOW_FILENAME);
  writeFileSync(filePath, `---\nname: ${options.name ?? options.id}\ndescription: plugin skill\ndisable-model-invocation: true\ncustom: keep\n---\nPlugin body\n`, "utf8");
  return {
    id: options.id,
    pluginId: `plugin-${options.id}`,
    pluginName: `Plugin ${options.id}`,
    name: options.name ?? options.id,
    description: "cached description",
    filePath,
    pluginVersion: "1.0.0",
    installPath: directory,
    skillRelativePath: "SKILL.md",
    publisherUserId: options.owner ?? 7,
    marketplaceTeamId: null,
  };
}

describe("reading plugin skill files", () => {
  it("reads the frontmatter, body, invocation flag and sorted helper files", (t) => {
    const current = world();
    const filePath = join(current.root, "skill", "SKILL.md");
    mkdirSync(join(current.root, "skill"), { recursive: true });
    writeFileSync(filePath, "---\nname: Plugin skill\ndescription: Use the helper\ndisable-model-invocation: true\n---\nBody\n", "utf8");
    writeFileSync(join(current.root, "skill", "z.sh"), "z", "utf8");
    writeFileSync(join(current.root, "skill", "a.txt"), "a", "utf8");
    writeFileSync(join(current.root, "skill", WORKFLOW_FILENAME + ".backup"), "backup", "utf8");
    assert.deepEqual(readPluginSkillFileFacts(filePath), {
      name: "Plugin skill",
      description: "Use the helper",
      body: "Body",
      disableModelInvocation: true,
      helperScripts: ["SKILL.md.backup", "a.txt", "z.sh"],
    });
    assert.equal(readPluginSkillFileFacts(join(current.root, "missing.md")), null);
    writeFileSync(filePath, "---\nname: Empty\n---\n", "utf8");
    assert.equal(readPluginSkillFileFacts(filePath), null);
    t.after(() => current.store.library.dir.stopWatching());
  });
});

describe("where an agent's workflows come from", () => {
  it("recognizes enabled-workflow state and legacy workflow files", () => {
    const current = world();
    assert.equal(agentHasWorkflows(current.agentDir), false);
    writeFileSync(join(current.agentDir, "enabled-workflows.json"), JSON.stringify({ disabled: ["one"] }), "utf8");
    assert.equal(agentHasWorkflows(current.agentDir), true);

    const otherAgent = join(current.root, "agents", "agent-b");
    const legacyFile = join(otherAgent, LEGACY_WORKFLOWS_DIRNAME, "old", "workflow.md");
    mkdirSync(join(otherAgent, LEGACY_WORKFLOWS_DIRNAME, "old"), { recursive: true });
    writeFileSync(legacyFile, "# Old workflow\n\nDo something.", "utf8");
    assert.equal(agentHasWorkflows(otherAgent), true);
  });

  it("moves valid legacy per-agent workflows into the shared library and enables them", () => {
    const current = world();
    const oldDirectory = join(current.agentDir, LEGACY_WORKFLOWS_DIRNAME, "legacy-one");
    mkdirSync(oldDirectory, { recursive: true });
    writeFileSync(join(oldDirectory, "workflow.md"), "# Legacy title\n\nLegacy body.", "utf8");

    const migrated = new FileWorkflowStore(current.agentDir, current.globalDir);
    cleanups.push(() => migrated.automations.dir.stopWatching());
    cleanups.push(() => migrated.library.dir.stopWatching());
    cleanups.push(() => migrated.managedDirWatcher.stopWatching());
    cleanups.push(() => migrated.pluginSkillsDirWatcher.stopWatching());

    assert.equal(existsSync(join(current.agentDir, LEGACY_WORKFLOWS_DIRNAME)), false);
    assert.equal(existsSync(join(current.globalDir, "legacy-one", WORKFLOW_FILENAME)), true);
    assert.deepEqual(
      [migrated.get("legacy-one")?.name, migrated.get("legacy-one")?.body, migrated.get("legacy-one")?.isEnabledForAgent],
      ["legacy-one", "# Legacy title\n\nLegacy body.", true],
    );
  });

  it("combines managed, plugin, global and automation records with higher-priority ids winning", () => {
    const current = world();
    current.store.create(workflow("Shared", "Global wins"));
    current.store.create(workflow("Local workflow", "User body"));

    writeManagedSkillsCache(current.store.managedDir, [
      { id: "managed-one", name: "Managed", description: "Managed skill", body: "Managed body" },
      { id: "shared", name: "Collision", description: "Lower priority", body: "Should be hidden" },
    ], () => 10);
    const pluginOne = addPluginSkill(current, { id: "plugin-one" });
    const pluginCollision = addPluginSkill(current, { id: "shared" });
    writePluginSkillsCache(current.store.pluginSkillsDir, {
      currentUserId: 7,
      skills: [pluginOne, pluginCollision],
    }, () => 20);
    current.store.createAutomation({ name: "Scheduled", description: "", body: "Do later", trigger: { schedule: "0 9 * * *", isEnabled: true } });

    const records = current.store.listAll();
    assert.deepEqual(records.slice(0, 2).map((record) => [record.id, record.source]), [
      ["managed-one", "managed"], ["plugin-one", "plugin"],
    ]);
    assert.deepEqual(new Set(records.map((record) => record.id)), new Set(["managed-one", "plugin-one", "shared", "local-workflow", "scheduled"]));
    assert.deepEqual(records.slice(-1).map((record) => [record.id, record.source]), [["scheduled", "automation"]]);
    assert.deepEqual(records.filter((record) => record.source === "workflow").length, 2);
    assert.equal(records.find((record) => record.id === "plugin-one")?.publishedByCurrentUser, true);
    assert.equal(records.some((record) => record.body === "Should be hidden"), false);
    assert.equal(current.store.get("managed-one")?.filePath.endsWith("SKILL.md"), true);
  });
});

describe("editing workflows by source", () => {
  it("creates library workflows and scheduled automations through their own stores", () => {
    const current = world();
    const created = current.store.create(workflow("Runbook", "Step one\nStep two", { sourceRef: "https://example.test/runbook" }));
    assert.deepEqual([created?.source, created?.name, created?.sourceRef, created?.isEnabledForAgent], ["workflow", "Runbook", "https://example.test/runbook", true]);
    assert.equal(current.store.library.get(created!.id)?.body, "Step one\nStep two");

    const scheduled = current.store.create(workflow("Every morning", "Check the inbox", { trigger: { schedule: "0 9 * * 1-5", isEnabled: true } }));
    assert.deepEqual([scheduled?.source, scheduled?.trigger?.schedule, scheduled?.trigger?.isEnabled], ["automation", "0 9 * * 1-5", true]);
    assert.equal(current.store.create(workflow("No body", " ")), null);
    assert.equal(current.store.create(workflow("No name", "body", { name: " " })), null);
  });

  it("updates an automation without losing its run time, and changes its trigger switch separately", () => {
    const current = world();
    const created = current.store.createAutomation(workflow("Scheduled", "First prompt", { trigger: { schedule: "0 9 * * *", isEnabled: true } }))!;
    current.store.automations.recordRun(created.id, 500);
    const updated = current.store.update(created.id, workflow("Renamed", "New prompt", { trigger: { schedule: "0 11 * * *", isEnabled: false } }))!;
    assert.deepEqual([updated.name, updated.body, updated.trigger?.schedule, updated.trigger?.isEnabled, updated.lastRunAt], ["Renamed", "New prompt", "0 11 * * *", false, 500]);
    assert.equal(current.store.setTriggerEnabled(created.id, true)?.trigger?.isEnabled, true);
  });

  it("changes user enablement but leaves managed and plugin sources read-only", () => {
    const current = world();
    const userWorkflow = current.store.create(workflow("Disable me"))!;
    writeManagedSkillsCache(current.store.managedDir, [{ id: "managed-one", name: "Managed", description: "", body: "body" }], () => 10);
    const plugin = addPluginSkill(current, { id: "plugin-one", owner: 7 });
    writePluginSkillsCache(current.store.pluginSkillsDir, { currentUserId: 7, skills: [plugin] }, () => 20);

    assert.equal(current.store.setEnabledForAgent(userWorkflow.id, false)?.isEnabledForAgent, false);
    assert.equal(current.store.setEnabledForAgent("managed-one", false)?.isEnabledForAgent, true);
    assert.equal(current.store.setEnabledForAgent("plugin-one", false)?.isEnabledForAgent, true);
    assert.deepEqual([current.store.remove("managed-one"), current.store.remove("plugin-one")], [false, false]);
    assert.deepEqual(current.store.list().map((record) => record.id), ["managed-one", "plugin-one"]);
    assert.equal(current.store.listAll().some((record) => record.id === userWorkflow.id), true);
  });

  it("updates only a plugin skill published by the current user, preserving its other frontmatter", () => {
    const current = world();
    const owned = addPluginSkill(current, { id: "mine", owner: 7 });
    const foreign = addPluginSkill(current, { id: "theirs", owner: 9 });
    writePluginSkillsCache(current.store.pluginSkillsDir, { currentUserId: 7, skills: [owned, foreign] }, () => 20);
    assert.equal(current.store.update("theirs", workflow("Updated", "body")), null);
    const updated = current.store.update("mine", workflow("Renamed skill", "Updated body", { description: "New description" }));
    assert.deepEqual([updated?.name, updated?.body, updated?.description, updated?.publishedByCurrentUser], ["Renamed skill", "Updated body", "New description", true]);
    assert.match(readFileSync(owned.filePath, "utf8"), /custom: "keep"/);
  });
});

describe("importing and migrating workflows", () => {
  it("imports markdown with its frontmatter and makes a live source pointer", () => {
    const current = world();
    const markdown = current.store.importMarkdown("# Imported\n\nUseful body.");
    assert.deepEqual([markdown?.name, current.store.get(markdown!.id)?.body], ["Imported", "# Imported\n\nUseful body."]);
    const live = current.store.importLiveSource("https://example.test/skills/daily-check.md");
    assert.deepEqual([live?.name, current.store.get(live!.id)?.sourceRef], ["daily check", "https://example.test/skills/daily-check.md"]);
    assert.match(current.store.get(live!.id)?.body ?? "", /live reference to the skill/);
    assert.equal(current.store.importMarkdown("", ""), null);
  });

  it("ports local skill files once, with project and home references deduplicated", () => {
    const current = world();
    const project = join(current.root, "project");
    const home = join(current.root, "home");
    mkdirSync(join(project, ".cursor", "rules"), { recursive: true });
    mkdirSync(join(home, ".claude"), { recursive: true });
    writeFileSync(join(project, "CLAUDE.md"), "# Project rules\n\nUse the project.", "utf8");
    writeFileSync(join(project, "AGENTS.md"), "# Agent rules\n\nUse the agent.", "utf8");
    writeFileSync(join(project, ".cursor", "rules", "review.mdc"), "# Review\n\nReview the diff.", "utf8");
    writeFileSync(join(home, "CLAUDE.md"), "# Home rules\n\nUse the home.", "utf8");
    writeFileSync(join(home, ".claude", "CLAUDE.md"), "# Nested home\n\nUse nested.", "utf8");

    const discovered = discoverLocalSkillFiles(home, project);
    assert.equal(discovered.length, 5);
    const result = current.store.portLocalSkills(home, project);
    assert.equal(result.imported.length, 5);
    assert.deepEqual(result.skipped, []);
    assert.equal(current.store.listAll().filter((record) => record.source === "workflow").length, 5);
  });
});
