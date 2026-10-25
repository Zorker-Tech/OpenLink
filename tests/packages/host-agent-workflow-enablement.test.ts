import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, describe, it } from "node:test";

import {
  AGENT_WORKFLOW_STATE_FILENAME,
  AgentWorkflowAccess,
  agentWorkflowStatePath,
} from "../../source/host/agents/agent-workflow-enablement.ts";

const roots: string[] = [];

function agentDirectory(): string {
  const directory = mkdtempSync(join(tmpdir(), "slate-workflow-access-"));
  roots.push(directory);
  return directory;
}

function writeState(directory: string, state: unknown): void {
  writeFileSync(agentWorkflowStatePath(directory), `${JSON.stringify(state)}\n`);
}

function readState(directory: string): Record<string, unknown> {
  return JSON.parse(readFileSync(agentWorkflowStatePath(directory), "utf8")) as Record<string, unknown>;
}

after(() => {
  for (const directory of roots) rmSync(directory, { recursive: true, force: true });
});

describe("per-agent workflow access", () => {
  it("keeps the state file beside the agent and defaults to enabled", () => {
    const directory = agentDirectory();
    const access = new AgentWorkflowAccess(directory);
    assert.equal(AGENT_WORKFLOW_STATE_FILENAME, "enabled-workflows.json");
    assert.equal(agentWorkflowStatePath(directory), join(directory, AGENT_WORKFLOW_STATE_FILENAME));
    assert.equal(access.filePath, agentWorkflowStatePath(directory));
    assert.equal(access.isWorkflowEnabled("nightly"), true);
    assert.equal(access.hasWorkflowFlags(), false);
    access.setWorkflowEnabled("nightly", true);
    assert.equal(existsSync(access.filePath), false);
  });

  it("treats unreadable and non-record state as no explicit preferences", () => {
    const directory = agentDirectory();
    const access = new AgentWorkflowAccess(directory);
    for (const contents of ["not json", "[]", "null"]) {
      writeFileSync(access.filePath, contents);
      assert.equal(access.isWorkflowEnabled("nightly"), true);
      assert.equal(access.hasWorkflowFlags(), false);
    }
  });

  it("uses only string ids from the disabled list", () => {
    const directory = agentDirectory();
    writeState(directory, { disabled: ["nightly", 7, null, "weekly", "nightly"] });
    const access = new AgentWorkflowAccess(directory);
    assert.equal(access.isWorkflowEnabled("nightly"), false);
    assert.equal(access.isWorkflowEnabled("weekly"), false);
    assert.equal(access.isWorkflowEnabled("7"), true);
    assert.equal(access.hasWorkflowFlags(), true);
  });

  it("creates its parent directory and writes disabled ids in stable order", () => {
    const directory = join(agentDirectory(), "nested", "agent");
    const access = new AgentWorkflowAccess(directory);
    access.setWorkflowEnabled("zeta", false);
    access.setWorkflowEnabled("alpha", false);
    assert.deepEqual(readState(directory), { disabled: ["alpha", "zeta"] });
    assert.equal(readFileSync(access.filePath, "utf8").endsWith("}\n"), true);
    assert.deepEqual(readdirSync(directory), [AGENT_WORKFLOW_STATE_FILENAME]);
  });

  it("preserves legacy enabled ids while writing the disabled set", () => {
    const directory = agentDirectory();
    writeState(directory, { enabled: ["legacy-z", 9, "legacy-a", "legacy-z"], disabled: ["off"] });
    const access = new AgentWorkflowAccess(directory);
    access.setWorkflowEnabled("new", false);
    assert.deepEqual(readState(directory), {
      disabled: ["new", "off"],
      enabled: ["legacy-a", "legacy-z"],
    });
    assert.equal(access.isWorkflowEnabled("legacy-a"), true);
    assert.equal(access.hasWorkflowFlags(), true);
  });

  it("recognizes the legacy enabled list even when nothing is disabled", () => {
    const directory = agentDirectory();
    writeState(directory, { enabled: ["legacy"], disabled: [] });
    const access = new AgentWorkflowAccess(directory);
    assert.equal(access.isWorkflowEnabled("legacy"), true);
    assert.equal(access.hasWorkflowFlags(), true);
  });

  it("avoids redundant writes, forgets one disabled id and enables a batch", () => {
    const directory = agentDirectory();
    writeState(directory, { disabled: ["alpha", "beta", "gamma"], enabled: ["legacy"] });
    const access = new AgentWorkflowAccess(directory);
    const before = readFileSync(access.filePath, "utf8");
    access.setWorkflowEnabled("alpha", false);
    access.forgetWorkflow("missing");
    assert.equal(readFileSync(access.filePath, "utf8"), before);

    access.forgetWorkflow("alpha");
    assert.deepEqual(readState(directory), { disabled: ["beta", "gamma"], enabled: ["legacy"] });
    access.enableWorkflows(["gamma", "missing", "beta"]);
    assert.deepEqual(readState(directory), { disabled: [], enabled: ["legacy"] });
    assert.equal(access.isWorkflowEnabled("beta"), true);
    assert.equal(access.hasWorkflowFlags(), true);
  });
});
