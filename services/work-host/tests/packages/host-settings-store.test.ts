/**
 * The user's settings file: defaults, every setter/getter pair, coercions, migrations and account scoping.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { SlateSettingsStore, SLATE_DOWNGRADE_MAX_FAST_MIGRATION_ID, SETTINGS_VERSION } from "../../source/shared/node/settings/slate-settings-store.ts";

const newStore = (name = "settings.json") => new SlateSettingsStore(join(mkdtempSync(join(tmpdir(), "settings-suite-")), name));

test("an empty store answers with the platform defaults", () => {
  const store = newStore();
  assert.equal(store.load().version, SETTINGS_VERSION);
  assert.deepEqual(store.load().mcpBoxServers, []);
  assert.equal(store.getAutoUpdateWhenIdleOptIn(), false);
  assert.equal(store.getEgressTunnelEnabled(), false);
  assert.equal(store.getWebauthnProxyEnabled(), true);
  assert.equal(store.getHasSeenOnboarding(), undefined);
  assert.equal(store.getUpdateTrackOverride(), null);
  assert.equal(store.getAgentDefaultModel(), undefined);
  assert.equal(store.getComputerUseModel(), undefined);
  assert.equal(store.getUserTimeZone(), undefined);
  assert.equal(store.getPinnedAgentIds(), undefined);
  assert.equal(store.getSidebarGrouping(), undefined);
  assert.equal(store.getRawMcpCustomInstruction("missing"), undefined);
  assert.equal(store.getInferenceProvider(), "slate");
  assert.equal(typeof store.getThemePreference(), "string");
  assert.equal(typeof store.getBoxRuntime(), "string");
  assert.equal(typeof store.getAutoReviewInstructions(), "object");
  assert.equal(typeof store.getLocalToolPermission(), "string");
});

test("boolean and simple settings round-trip through the file", () => {
  const store = newStore();
  store.setHasSeenOnboarding(true);
  store.setAutoUpdateWhenIdleOptIn(true);
  store.setEgressTunnelEnabled(true);
  store.setWebauthnProxyEnabled(false);
  store.setThemePreference("system");
  store.setBoxRuntime("local-docker");
  const loaded = new SlateSettingsStore(store.settingsPath).load();
  assert.equal(loaded.hasSeenOnboarding, true);
  assert.equal(loaded.autoUpdateWhenIdleOptIn, true);
  assert.equal(loaded.egressTunnelEnabled, true);
  assert.equal(loaded.webauthnProxyEnabled, false);
  assert.equal(loaded.themePreference, "system");
  assert.equal(loaded.boxRuntime, "local-docker");
  store.clearHasSeenOnboarding();
  assert.equal(store.getHasSeenOnboarding(), undefined);
});

test("models keep their shape and the agent default is forced into max mode", () => {
  const store = newStore();
  store.setAgentDefaultModel({ modelId: "m", maxMode: false, parameters: [{ id: "fast", value: "true" }, { id: "x", value: "1" }] });
  assert.deepEqual(store.getAgentDefaultModel(), { modelId: "m", maxMode: true, parameters: [{ id: "fast", value: "true" }, { id: "x", value: "1" }] });
  store.setComputerUseModel({ modelId: "c", maxMode: true, parameters: [{ id: "a", value: "b" }] });
  assert.deepEqual(store.getComputerUseModel(), { modelId: "c", maxMode: true, parameters: [{ id: "a", value: "b" }] });
  store.setAgentDefaultModel(undefined);
  store.setComputerUseModel(undefined);
  assert.equal(store.getAgentDefaultModel(), undefined);
  assert.equal(store.getComputerUseModel(), undefined);
});

test("MCP custom instructions clamp, drop empties and keep defaults", () => {
  const store = newStore();
  store.setMcpCustomInstructions({ a: "  hello  ", b: "   " });
  assert.deepEqual(store.getMcpCustomInstructions(), { a: "  hello  " });
  store.setMcpCustomInstructionsByServerId({ "1": " first ", "0": "no", "x": "no", "2": "  second  " });
  assert.deepEqual(store.getMcpCustomInstructionsByServerId(), { "1": " first ", "2": "  second  " });
  store.setMcpDisabledToolsByServerId({ "1": ["a", "a", " "], "0": ["x"], "2": ["b"] });
  assert.deepEqual(store.getMcpDisabledToolsByServerId(), { "1": ["a", " "], "2": ["b"] });
  store.setMcpCustomInstruction("legacy", " text ");
  assert.equal(store.getRawMcpCustomInstruction("legacy"), " text ");
  store.deleteMcpCustomInstruction("legacy");
  assert.equal(store.getRawMcpCustomInstruction("legacy"), undefined);
});

test("instructions move from a legacy name to a server id and can be deleted", () => {
  const store = newStore();
  store.setMcpCustomInstruction("legacy name", " from legacy ");
  store.migrateMcpCustomInstructionToServerId({ serverId: "3", displayName: "legacy name" });
  assert.equal(store.getRawMcpCustomInstructionByServerId("3"), " from legacy ");
  store.setMcpCustomInstructionByServerId({ serverId: "3", displayName: "legacy name", value: " updated ", mirrorLegacyName: true });
  assert.equal(store.getRawMcpCustomInstructionByServerId("3"), " updated ");
  assert.equal(store.getRawMcpCustomInstruction("legacy name"), " updated ");
  store.deleteMcpCustomInstructionByServerId({ serverId: "3", displayName: "legacy name", deleteLegacyName: true });
  assert.equal(store.getRawMcpCustomInstructionByServerId("3"), undefined);
  assert.equal(store.getRawMcpCustomInstruction("legacy name"), undefined);
});

test("timezones are trimmed and cleared, and boxes and pins are de-duplicated", () => {
  const store = newStore();
  store.setUserTimeZone("  Europe/Berlin  ");
  store.setUserTimeZoneOverride("UTC");
  assert.equal(store.getUserTimeZone(), "UTC");
  assert.equal(store.getDetectedUserTimeZone(), "Europe/Berlin");
  assert.equal(store.getUserTimeZoneOverride(), "UTC");
  store.setUserTimeZone("   ");
  store.setUserTimeZoneOverride(undefined);
  assert.equal(store.getUserTimeZone(), undefined);
  store.setMcpBoxServers(["b", "a", "b"]);
  assert.deepEqual(store.getMcpBoxServers(), ["b", "a"]);
  store.setPinnedAgentIds(["x", "y", "x"]);
  assert.deepEqual(store.getPinnedAgentIds(), ["x", "y"]);
});

test("notification configuration is always persisted as disabled", () => {
  const store = newStore();
  const config = store.getNotificationConfig();
  assert.equal(config.isEnabled, false);
  assert.deepEqual(store.load().notifications, { isEnabled: false });
  store.setNotificationConfig({ isEnabled: true });
  assert.deepEqual(store.load().notifications, { isEnabled: false });
});

test("auto-review instructions are stored only when they do something", () => {
  const store = newStore();
  store.setAutoReviewInstructions({ isEnabled: true, allowInstructions: [], blockInstructions: [] });
  assert.equal(store.load().autoReviewInstructions, undefined);
  store.setAutoReviewInstructions({ isEnabled: false, allowInstructions: [], blockInstructions: ["x"] });
  assert.equal(store.load().autoReviewInstructions?.isEnabled, false);
});

test("local tool permission resolves the stored choice against its ceiling", () => {
  const store = newStore();
  assert.equal(typeof store.getLocalToolPermissionChoice(), "string");
  store.setLocalToolPermission("ask");
  store.setLocalToolPermissionCeiling("always");
  assert.equal(store.getLocalToolPermissionChoice(), "ask");
  assert.equal(store.getLocalToolPermissionCeiling(), "always");
  assert.equal(typeof store.getLocalToolPermission(), "string");
  store.setLocalToolPermissionCeiling(undefined);
  assert.equal(store.getLocalToolPermissionCeiling(), undefined);
});

test("inference usage accumulates with rounded safe numbers", () => {
  const store = newStore();
  store.recordInferenceUsage("slate", { inputTokens: 10.6, outputTokens: -1, cacheReadTokens: 2 });
  const usage = store.getInferenceRouterUsage();
  assert.equal(usage.providers.slate.requests, 1);
  assert.equal(usage.providers.slate.inputTokens, 11);
  assert.equal(usage.providers.slate.outputTokens, 0);
  assert.equal(usage.providers.slate.cacheReadTokens, 2);
  assert.equal(usage.providers.slate.cacheWriteTokens, 0);
  assert.equal(typeof usage.providers.slate.lastUsedAt, "string");
});

test("account scoping keeps onboarding for the scoped account and drops per-account data on change", () => {
  const store = newStore();
  store.scopeToAccount("acct-1");
  const afterFirst = store.load();
  assert.equal(afterFirst.mcpCustomInstructionsAccountScope, "acct-1");
  store.scopeToAccount("acct-2");
  const afterSecond = store.load();
  assert.equal(afterSecond.mcpCustomInstructionsAccountScope, "acct-2");
  store.clearAccountScope();
  const cleared = store.load();
  assert.equal(cleared.mcpCustomInstructionsAccountScope, undefined);
  assert.deepEqual(cleared.mcpCustomInstructions, {});
});

test("unknown, corrupt and version-mismatched files fall back to defaults", () => {
  const store = newStore("version.json");
  writeFileSync(store.settingsPath, JSON.stringify({ version: 99, mcpBoxServers: ["x"] }));
  assert.deepEqual(store.load().mcpBoxServers, []);
  const corrupt = newStore("corrupt.json");
  writeFileSync(corrupt.settingsPath, "{not json");
  assert.equal(corrupt.load().version, SETTINGS_VERSION);
  const partial = newStore("partial.json");
  writeFileSync(partial.settingsPath, JSON.stringify({ version: 1, mcpBoxServers: ["a", "a", 7, ""], webauthnProxyEnabled: "no", notifications: [] }));
  assert.deepEqual(partial.load().mcpBoxServers, ["a"]);
  assert.equal(partial.load().webauthnProxyEnabled, true);
  assert.equal(partial.load().notifications, undefined);
});

test("the downgrade migration disables fast mode once", () => {
  const store = newStore("downgrade.json");
  writeFileSync(store.settingsPath, JSON.stringify({ version: 1, settingsMigrations: [], agentDefaultModel: { modelId: "m", maxMode: true, parameters: [{ id: "fast", value: "true" }, { id: "other", value: "keep" }] } }));
  const loaded = store.load();
  assert.equal(loaded.settingsMigrations.includes(SLATE_DOWNGRADE_MAX_FAST_MIGRATION_ID), true);
  assert.deepEqual(loaded.agentDefaultModel, { modelId: "m", maxMode: true, parameters: [{ id: "fast", value: "false" }, { id: "other", value: "keep" }] });
  const onDisk = JSON.parse(readFileSync(store.settingsPath, "utf8")) as { settingsMigrations: string[] };
  assert.equal(onDisk.settingsMigrations.includes(SLATE_DOWNGRADE_MAX_FAST_MIGRATION_ID), true);
  assert.equal(store.load().settingsMigrations.filter((id) => id === SLATE_DOWNGRADE_MAX_FAST_MIGRATION_ID).length, 1);
});

test("sidebar grouping is stored in its flattened form", () => {
  const store = newStore();
  store.setSidebarGrouping([{ id: "g1", name: "one", agentIds: ["a", "b"], isCollapsed: true }, { id: "g2", name: "two", agentIds: [] }]);
  const grouping = store.getSidebarGrouping()!;
  assert.deepEqual(grouping.filter((section) => section.id !== "__agents__").map(({ id, name, agentIds, isCollapsed }) => ({ id, name, agentIds, isCollapsed })), [{ id: "g1", name: "one", agentIds: ["a", "b"], isCollapsed: true }, { id: "g2", name: "two", agentIds: [], isCollapsed: false }]);
  const store2 = newStore();
  const stored = store.load().sidebarSections;
  const storable = SlateSettingsStore.storable({ sections: store.getSidebarGrouping()!, ...(stored === undefined ? {} : { stored }) });
  assert.deepEqual(storable.filter((section) => section.id !== "__agents__").map(({ id, name, agentIds, isCollapsed }) => ({ id, name, agentIds, isCollapsed })), [{ id: "g1", name: "one", agentIds: ["a", "b"], isCollapsed: true }, { id: "g2", name: "two", agentIds: [], isCollapsed: false }]);
});

test("writes are atomic and leave no temporary files behind", () => {
  const store = newStore();
  store.setHasSeenOnboarding(true);
  store.setPinnedAgentIds(["x"]);
  const directory = join(store.settingsPath, "..");
  assert.deepEqual(readdirSync(directory).filter((name) => name.endsWith(".tmp")), []);
  assert.equal(readdirSync(directory).length, 1);
});
