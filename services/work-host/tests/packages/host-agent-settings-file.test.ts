import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, describe, it } from "node:test";

import {
  DEFAULT_HIDDEN_FROM_SIDEBAR,
  DEFAULT_NOTIFY_ON_AGENT_UPDATES,
  SLATE_SETTINGS_FILENAME,
  getSlateSettingsPath,
  agentSettingsAt,
  writeAgentSettings,
} from "../../source/host/agents/settings-file.ts";

const roots: string[] = [];
const scratch = (): string => {
  const root = mkdtempSync(join(tmpdir(), "slate-settings-"));
  roots.push(root);
  return root;
};
after(() => {
  for (const root of roots) rmSync(root, { recursive: true, force: true });
});

describe("an agent's own settings", () => {
  it("are two switches in one file beside the agent", () => {
    assert.equal(SLATE_SETTINGS_FILENAME, "settings.json");
    assert.equal(getSlateSettingsPath("/agents/a1"), join("/agents/a1", "settings.json"));
    assert.equal(DEFAULT_NOTIFY_ON_AGENT_UPDATES, true);
    assert.equal(DEFAULT_HIDDEN_FROM_SIDEBAR, false);
  });

  it("answer the defaults when the file is missing, unreadable or says nothing about them", () => {
    const dir = scratch();
    const path = getSlateSettingsPath(dir);
    const defaults = { notifyOnAgentUpdates: true, hiddenFromSidebar: false };
    assert.deepEqual(agentSettingsAt(path), defaults);
    writeFileSync(path, "{not json");
    assert.deepEqual(agentSettingsAt(path), defaults);
    writeFileSync(path, JSON.stringify({ notifyOnAgentUpdates: "yes", hiddenFromSidebar: 1 }));
    assert.deepEqual(agentSettingsAt(path), defaults, "a switch that is not a boolean is not a switch");
    writeFileSync(path, JSON.stringify({ notifyOnAgentUpdates: false }));
    assert.deepEqual(agentSettingsAt(path), { notifyOnAgentUpdates: false, hiddenFromSidebar: false }, "one switch set, the other defaulted");
  });

  it("are written beside the agent, leaving what the caller did not mention as the file had it", () => {
    const dir = scratch();
    const path = getSlateSettingsPath(dir);
    writeAgentSettings(path, { hiddenFromSidebar: true });
    assert.deepEqual(agentSettingsAt(path), { notifyOnAgentUpdates: true, hiddenFromSidebar: true });
    writeAgentSettings(path, { notifyOnAgentUpdates: false });
    assert.deepEqual(agentSettingsAt(path), { notifyOnAgentUpdates: false, hiddenFromSidebar: true }, "the switch the caller did not mention is kept");
  });

  it("are written whole: a file lands complete, ending in a newline", () => {
    const dir = join(scratch(), "nested");
    const path = getSlateSettingsPath(dir);
    writeAgentSettings(path, { notifyOnAgentUpdates: false, hiddenFromSidebar: true });
    const written = readFileSync(path, "utf8");
    assert.equal(written.endsWith("}\n"), true);
    assert.deepEqual(JSON.parse(written), { notifyOnAgentUpdates: false, hiddenFromSidebar: true });
  });

  it("keep a field the file holds that this build does not know about", () => {
    const dir = scratch();
    const path = getSlateSettingsPath(dir);
    writeFileSync(path, JSON.stringify({ notifyOnAgentUpdates: true, somethingElse: "kept" }));
    writeAgentSettings(path, { hiddenFromSidebar: true });
    assert.equal((JSON.parse(readFileSync(path, "utf8")) as Record<string, unknown>)["somethingElse"], "kept");
  });
});
