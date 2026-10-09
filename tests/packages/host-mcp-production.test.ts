/**
 * MCP as the host runs it: what the extension's factories are made of, and what the host's own root decides.
 */

import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";

import { createMcpProductionExtras } from "../../source/host/mcp/production.ts";
import { McpHostService } from "../../source/host/mcp/mcp-service.ts";
import { PLUGIN_SKILLS_REFRESH_INTERVAL_MS, SlatePluginSkillsService } from "../../source/host/skills/plugin-skills.ts";
import { SlateSkillPublishService } from "../../source/host/skills/skill-publish.ts";
import type { McpPluginSkillsService } from "../../source/host/mcp/extension.ts";

/** A root of its own, so the cleanup and the sweep see only what the test put there. */
function rootWorld() {
  const root = mkdtempSync(join(tmpdir(), "slate-mcp-production-"));
  const previous = process.env["SLATE_DATA_ROOT"];
  process.env["SLATE_DATA_ROOT"] = root;
  return {
    root,
    restore: () => {
      if (previous === undefined) delete process.env["SLATE_DATA_ROOT"];
      else process.env["SLATE_DATA_ROOT"] = previous;
      rmSync(root, { recursive: true, force: true });
    },
  };
}

/** The plugin skills the extension would build, with what the host reads of them recorded. */
function fakeSkills() {
  const calls: string[] = [];
  const skills: McpPluginSkillsService = {
    sync: async (trigger: string) => {
      calls.push(`sync:${trigger}`);
      return [
        { id: "s1", pluginId: "77", pluginName: "Mine", name: "deploy", description: "d", filePath: "/skills/deploy", pluginVersion: "1", installPath: "/p", skillRelativePath: "deploy", publisherUserId: null, marketplaceTeamId: null },
      ];
    },
    handleAuthChange: () => void calls.push("handleAuthChange"),
    dispose: () => void calls.push("dispose"),
    currentIndex: () => null,
    currentAuthBlocked: () => [{ pluginId: "77", pluginName: "Mine" }],
  };
  return { skills, calls };
}

function productionWorld() {
  const logs: Array<[string, unknown]> = [];
  const hostLogs: string[] = [];
  const world = rootWorld();
  const extras = createMcpProductionExtras({
    deps: {
      auth: {
        getAccessToken: async () => "token",
        getMachineId: async () => "machine-1",
        peekAccessToken: () => "token",
        subscribeToRenewal: () => () => {},
      },
      experiments: { isSparsePluginClonesEnabled: () => false },
      "forever-box": { box: {} as never },
      settings: {},
      telemetry: {
        logs: {
          reportMcpDiscoveryFailed: (event: unknown) => void logs.push(["discovery", event]),
          reportConnectorAuth: (event: unknown) => void logs.push(["connector", event]),
          reportPluginSkillsSync: (event: unknown) => void logs.push(["sync", event]),
          reportSkillPublishEdgeFailed: (event: unknown) => void logs.push(["publish", event]),
        },
      },
    },
    host: { log: (message: string) => void hostLogs.push(message) },
  } as never);
  return { extras, logs, hostLogs, ...world };
}

describe("what the extension's factories are made of", () => {
  it("builds the plugin skills, the MCP host service and the skill publish from the host's own parts", () => {
    const world = productionWorld();
    try {
      const skills = world.extras.createPluginSkills();
      assert.equal(skills instanceof SlatePluginSkillsService, true);
      const service = world.extras.createService(skills);
      assert.equal(service instanceof McpHostService, true);
      assert.equal(world.extras.createSkillPublish(skills) instanceof SlateSkillPublishService, true);
      // The skills are refreshed on the platform's own schedule.
      const polling = world.extras.createPolling() as unknown as { name: string };
      assert.deepEqual([polling.name, PLUGIN_SKILLS_REFRESH_INTERVAL_MS > 0], ["slate-plugin-skills-refresh", true]);
    } finally {
      world.restore();
    }
  });

  it("hands the MCP host the plugin skills the way it reads them", async () => {
    const world = productionWorld();
    try {
      const fake = fakeSkills();
      const api = world.extras.createService(fake.skills).api;
      // A sync answers with the skills named the way the host names one, and the status is what the skills are blocked on.
      assert.deepEqual(await api.syncPluginSkills(), [{ pluginId: "77", pluginName: "Mine", name: "deploy", description: "d" }]);
      assert.deepEqual([fake.calls, api.pluginSyncStatus()], [["sync:desktop"], { authBlocked: [{ pluginId: "77", pluginName: "Mine" }] }]);
    } finally {
      world.restore();
    }
  });

  it("cleans up the credentials the old layout left in the host's own root", async () => {
    const world = productionWorld();
    try {
      // Nothing left behind is nothing to report, and what is left behind is reported with how much was removed.
      assert.deepEqual(await world.extras.cleanupLegacyAuth!(), { outcome: "not_found", removedCount: 0 });
      mkdirSync(world.root, { recursive: true });
      writeFileSync(join(world.root, "mcp-auth.json"), "{}", "utf8");
      writeFileSync(join(world.root, "mcp-auth.json.bak"), "{}", "utf8");
      writeFileSync(join(world.root, "settings.json"), "{}", "utf8");
      assert.deepEqual(await world.extras.cleanupLegacyAuth!(), { outcome: "deleted", removedCount: 2 });
      // What was not the old layout's is left where it was.
      assert.deepEqual([existsSync(join(world.root, "mcp-auth.json")), existsSync(join(world.root, "settings.json"))], [false, true]);
      assert.deepEqual(await world.extras.cleanupLegacyAuth!(), { outcome: "not_found", removedCount: 0 });
    } finally {
      world.restore();
    }
  });

  it("sweeps the old layout's references from a root with no skills to sweep", async () => {
    const world = productionWorld();
    try {
      // With no plugin skills installed there is nothing that could have been materialized.
      await assert.doesNotReject(() => Promise.resolve(world.extras.sweepLegacyReferences!()));
    } finally {
      world.restore();
    }
  });
});
