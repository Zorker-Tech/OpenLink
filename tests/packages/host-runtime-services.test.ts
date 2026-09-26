/**
 * The host's runtime pieces, second group: the snapshot trigger, the upgrade marker, the box's errors and
 * messages, the caches the agent reads, the guards around a page, a database and a workspace, and the frames
 * the codebase-telemetry helper speaks.
 */

import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, describe, it } from "node:test";

import { CodebaseSnapshotTrigger, MAX_HANDLED_REASONS, snapshotReasonKey, type SnapshotReason } from "../../source/host/extensions/codebase-telemetry/codebase-snapshot-trigger.ts";
import { computeHostUpgradeMetadata, forwardHostUpgradeMarkerWith, parseHostUpgradeMarker, type HostUpgradeMetadata } from "../../source/host/extensions/host-upgrade/host-upgrade-marker.ts";
import { createHostRequestContext, resolveTimeZone } from "../../source/host/host-request-context.ts";
import { SlateChannelDeliveryUnregisteredError } from "../../source/host/transcript/channel-delivery-unregistered-error.ts";
import { BOX_MCP_UNSUPPORTED_MESSAGE, isUnimplementedConnectError, loadBoxMcpServersViaTransport, SlateBoxMcpUnsupportedError } from "../../source/host/boxes/box-mcp.ts";
import { getManagedSkillFilePath, isManagedSkill, MANAGED_SKILLS_CACHE_FILENAME, readManagedSkillsCache, writeManagedSkillsCache } from "../../source/host/extensions/managed-setup/managed-skills-cache.ts";
import { boxNotReadyMessageForError, isNoMonitorComputerUseExecutor, isPrimaryWindowIndex, noMonitorComputerUseExecutor, SLATE_BOX_NOT_READY_MESSAGE, SLATE_BOX_NOT_RESPONDING_MESSAGE, SLATE_BOX_NO_MONITOR_AVAILABLE_MESSAGE, SlateBoxDaemonUnreachableError, SlateBoxNoMonitorAvailableError } from "../../source/host/ports/box.ts";
import { createSlateMcpStateExecutor } from "../../source/host/ports/mcp-state-executor.ts";
import { isSafePluginSkillId, readPluginSkillsCache, writePluginSkillsCache } from "../../source/host/skills/plugin-skills-cache.ts";
import { countListenerPlatforms, describeScopeIssues, isListenerPlatform, listenerPlatformsInTrigger } from "../../source/host/automations/listener-integrations.ts";
import { buildContentSnippet, entrySearchText, findAgentContentMatches, type SearchableTranscriptEntry } from "../../source/host/extensions/content-search/agent-content-search.ts";
import { asDisplayOwner, createBoxWallpaperCommands, parseTonePlan, readLiveDisplays } from "../../source/host/extensions/wallpaper/box-wallpaper-commands.ts";
import { McpAuthWaitRegistry } from "../../source/host/mcp/mcp-auth-wait-registry.ts";
import { classifyBotBlockPage, withBotBlockDetection } from "../../source/host/runner/bot-block-detection.ts";
import { isSqliteBusyError, isSqliteCorruptError, isSqliteIoError, retrySqliteBusy, SQLITE_BUSY } from "../../source/host/storage/sqlite-busy.ts";
import { SlateSendNotPersistedError } from "../../source/host/transcript/send-not-persisted-error.ts";
import { mergeTurnUsage, toSafeTokenCount, turnUsageFromTurnEnded, type TurnUsage } from "../../source/host/runner/turn-usage.ts";
import { backendCloudTrigger } from "../../source/host/automations/slate-automation-cloud-trigger.ts";
import { agentProfileIdentitiesEqual, normalizeAgentProfileIdentity, parseLatestAgentProfileUpdate, renderAgentProfileUpdate, resolveAgentProfilePromptSnapshot, SLATE_AGENT_PROFILE_UPDATE_MARKER } from "../../source/host/runner/slate-agent-profile-prompt.ts";
import { getBoxStoreBackendPolicy, isBoxStoreCopyInEnabled, isBoxStoreSyncEnabled, resolveBackendKind, SLATE_BOX_STORE_BACKEND_ENV, SLATE_BOX_STORE_LOCAL_DIR_ENV } from "../../source/host/boxes/box-store-backend-policy.ts";
import { BOX_STORE_HYDRATION_HANDOFF_MANIFEST_PATH, isBoxStoreFullyHydrated, isHydrationHandoffManifestPath, removeHydrationHandoffMarker, writeHydrationHandoffMarker } from "../../source/host/boxes/box-store-sync/box-store-hydration.ts";
import { CsnapsProtocolError, CsnapsResponseDecoder, decodeFramePayloads, encodeCsnapsRequest, encodeFrame, MAX_FRAME_BYTES, parseCsnapsOperationResult, parseCsnapsResponse } from "../../source/host/extensions/codebase-telemetry/csnaps-protocol.ts";
import { classifyLocalExecFailure } from "../../source/host/local-exec/local-exec-failure-classifier.ts";
import { compileWorkspaceIgnore, IGNORE_NOTHING, loadWorkspaceIgnore, negationReaches, parseIgnorePatterns } from "../../source/host/boxes/box-store-sync/workspace-ignore.ts";
import type { Context } from "../../source/packages/context/context.ts";

const scratch = mkdtempSync(join(tmpdir(), "slate-host-runtime-2-"));
after(() => { rmSync(scratch, { recursive: true, force: true }); });

const tick = () => new Promise((resolve) => setImmediate(resolve));
const context = {} as Context;

describe("asking the telemetry session for a snapshot", () => {
  it("asks once per reason, and does nothing when telemetry is not active", async () => {
    const reasons: SnapshotReason[] = [];
    const logged: string[] = [];
    const trigger = new CodebaseSnapshotTrigger({
      getSession: () => ({ snapshot: async (reason) => { reasons.push(reason); } }),
      logger: { debug: (message) => { logged.push(message); }, warn: () => {} },
    });
    trigger.handle({ type: "AGENT_REQUEST_START", requestId: "r1" });
    trigger.handle({ type: "AGENT_REQUEST_START", requestId: "r1" });
    trigger.handle({ type: "AGENT_REQUEST_END", requestId: "r1" });
    await tick();
    assert.deepEqual(reasons, [
      { type: "AGENT_REQUEST_START", requestId: "r1" },
      { type: "AGENT_REQUEST_END", requestId: "r1" },
    ]);
    assert.equal(snapshotReasonKey({ type: "AGENT_REQUEST_END", requestId: "r1" }), '["AGENT_REQUEST_END","r1"]');
    const idle = new CodebaseSnapshotTrigger({ getSession: () => undefined, logger: { debug: (message) => { logged.push(message); }, warn: () => {} } });
    idle.handle({ type: "AGENT_REQUEST_START", requestId: "r2" });
    assert.deepEqual(logged, ["snapshot trigger dropped (telemetry inactive): AGENT_REQUEST_START"]);
    assert.equal(MAX_HANDLED_REASONS, 1_000);
  });

  it("forgets a reason that failed, so it is tried again, and logs failures on a doubling schedule", async () => {
    const reasons: SnapshotReason[] = [];
    const warnings: string[] = [];
    const trigger = new CodebaseSnapshotTrigger({
      getSession: () => ({ snapshot: async (reason) => { reasons.push(reason); throw new Error("snapshot failed"); } }),
      logger: { debug: () => {}, warn: (message) => { warnings.push(message); } },
    });
    const reason: SnapshotReason = { type: "AGENT_REQUEST_START", requestId: "r3" };
    trigger.handle(reason);
    await tick();
    trigger.handle(reason);
    await tick();
    trigger.handle(reason);
    await tick();
    trigger.handle(reason);
    await tick();
    assert.equal(reasons.length, 4);
    assert.deepEqual(warnings, ["snapshot trigger failed (failure #1)", "snapshot trigger failed (failure #2)", "snapshot trigger failed (failure #4)"]);
  });
});

describe("what an upgrade left behind", () => {
  it("parses a marker defensively and turns its timing into the durations a report carries", () => {
    assert.equal(parseHostUpgradeMarker("not json"), null);
    assert.equal(parseHostUpgradeMarker("[1,2]"), null);
    assert.deepEqual(parseHostUpgradeMarker('{"outcome":"nonsense","mode":"swap"}'), { mode: "swap" });
    const applied = parseHostUpgradeMarker('{"outcome":"applied","fromVersion":"1.0","toVersion":"1.1","mode":"swap","reason":"update","issuedAtMs":1000,"appliedAtMs":1500,"swapMs":200}');
    assert.deepEqual(computeHostUpgradeMetadata(applied!, 2000), {
      from_version: "1.0",
      to_version: "1.1",
      mode: "swap",
      trigger: "update",
      outcome: "applied",
      deliver_to_apply_ms: "500",
      swap_ms: "200",
      total_ms: "1000",
    });
    const failed = parseHostUpgradeMarker('{"outcome":"failed","fromVersion":"1.0","toVersion":"1.1","swapError":"EPERM"}');
    assert.deepEqual(computeHostUpgradeMetadata(failed!, 0), {
      from_version: "1.0",
      to_version: "1.1",
      mode: undefined,
      trigger: undefined,
      outcome: "failed",
      phase: "swap",
      error_class: "EPERM",
    });
  });

  it("forwards a marker once, keeps one that could not be emitted, and discards one it cannot parse", async () => {
    const run = async (raw: string | null, options: { forwarded?: boolean; emit?: boolean } = {}) => {
      const emitted: HostUpgradeMetadata[] = [];
      let current = raw;
      const outcomes: string[] = [];
      const outcome = await forwardHostUpgradeMarkerWith({
        readRaw: async () => current,
        deleteMarker: async () => { current = null; outcomes.push("deleted"); },
        emit: async (metadata) => { emitted.push(metadata); return options.emit ?? true; },
        warn: (message) => { outcomes.push(message); },
        now: () => 5000,
        wasForwarded: () => options.forwarded ?? false,
        markForwarded: () => { outcomes.push("marked"); },
      });
      return { outcome, emitted, current, outcomes };
    };
    assert.equal((await run(null)).outcome, "absent");
    assert.equal((await run('{"outcome":"applied"}', { forwarded: true })).outcome, "skipped");
    const unparseable = await run("{oops");
    assert.equal(unparseable.outcome, "parse_error");
    assert.equal(unparseable.current, null);
    assert.match(unparseable.outcomes[0] ?? "", /discarding unparseable host-upgrade marker \(len=5\)/);
    const deferred = await run('{"outcome":"applied","issuedAtMs":1000}', { emit: false });
    assert.equal(deferred.outcome, "deferred");
    assert.equal(deferred.current, '{"outcome":"applied","issuedAtMs":1000}');
    const emitted = await run('{"outcome":"applied","issuedAtMs":1000}');
    assert.equal(emitted.outcome, "emitted");
    assert.equal(emitted.emitted.length, 1);
    assert.equal(emitted.emitted[0]?.total_ms, "4000");
    assert.deepEqual(emitted.outcomes, ["marked", "deleted"]);
  });
});

describe("the request context a host hands over", () => {
  it("carries the platform, the shell, the time zone and where transcripts live", () => {
    const contextFactory = createHostRequestContext("/tmp/transcripts", () => "Europe/Berlin", async () => ["rule"], () => "  Ada  ");
    const resolved = contextFactory.resolve();
    assert.equal(resolved.transcriptsFolder, "/tmp/transcripts");
    assert.equal(resolved.timeZone, "Europe/Berlin");
    assert.equal(resolved.userFullName, "Ada");
    assert.match(resolved.osVersion, /^\w+ /);
    assert.equal(contextFactory.resolveRules, contextFactory.resolveRules);
    assert.equal(typeof resolveTimeZone(), "string");
    const anonymous = createHostRequestContext("/tmp/transcripts").resolve();
    assert.equal(anonymous.userFullName, undefined);
    assert.equal(anonymous.timeZone, resolveTimeZone());
  });
});

describe("the two errors a transcript delivery raises", () => {
  it("name themselves, so a caller can tell them apart from anything else", () => {
    const unregistered = new SlateChannelDeliveryUnregisteredError();
    assert.equal(unregistered.name, "SlateChannelDeliveryUnregisteredError");
    assert.equal(unregistered.message, "No channel delivery mechanism is registered.");
    const notPersisted = new SlateSendNotPersistedError();
    assert.equal(notPersisted.name, "SlateSendNotPersistedError");
  });
});

describe("loading MCP servers into a box", () => {
  it("reports an image that predates MCP support, and passes other failures through", async () => {
    assert.equal(isUnimplementedConnectError({ code: 12 }), true);
    assert.equal(isUnimplementedConnectError({ code: "unimplemented" }), true);
    assert.equal(isUnimplementedConnectError({ code: "UNIMPLEMENTED" }), true);
    assert.equal(isUnimplementedConnectError({ code: 13 }), false);
    assert.equal(isUnimplementedConnectError("unimplemented"), false);
    const createClient = (transport: { readonly name: string }) => ({
      loadMcpServers: async (_ctx: Context, request: { mcpConfigJson: string; removeMissing: true }) => {
        if (transport.name === "old") throw { code: 12 };
        if (transport.name === "broken") throw { code: 13 };
        assert.equal(request.removeMissing, true);
        return { loadedServerNames: ["linear"] };
      },
    });
    assert.deepEqual(await loadBoxMcpServersViaTransport(context, { name: "new" }, "{}", createClient), ["linear"]);
    await assert.rejects(
      () => loadBoxMcpServersViaTransport(context, { name: "old" }, "{}", createClient),
      (error: unknown) => error instanceof SlateBoxMcpUnsupportedError && error.message === BOX_MCP_UNSUPPORTED_MESSAGE,
    );
    assert.match(BOX_MCP_UNSUPPORTED_MESSAGE, /^Slate's computer is running an older image without MCP support/);
    await assert.rejects(() => loadBoxMcpServersViaTransport(context, { name: "broken" }, "{}", createClient), (error: unknown) => (error as { code?: number }).code === 13);
  });
});

describe("the skills the platform manages", () => {
  it("writes the cache and a file per skill, and drops skills that are gone", () => {
    const cacheDir = join(scratch, "managed-skills");
    writeManagedSkillsCache(cacheDir, [{ id: "reviewer", name: "Reviewer", description: "reviews code", body: "Do the review." }], () => 42);
    const read = readManagedSkillsCache(cacheDir);
    assert.equal(read?.fetchedAt, 42);
    assert.deepEqual(read?.skills.map((skill) => skill.id), ["reviewer"]);
    assert.match(readFileSync(getManagedSkillFilePath(cacheDir, "reviewer"), "utf8"), /Do the review\./);
    assert.deepEqual(readdirSync(join(cacheDir, "skills")), ["reviewer"]);
    writeManagedSkillsCache(cacheDir, [{ id: "writer", name: "Writer", description: "writes", body: "Write it." }], () => 43);
    assert.deepEqual(readdirSync(join(cacheDir, "skills")), ["writer"]);
    assert.equal(readManagedSkillsCache(cacheDir)?.fetchedAt, 43);
    assert.equal(readManagedSkillsCache(join(scratch, "nowhere")), null);
    writeFileSync(join(cacheDir, MANAGED_SKILLS_CACHE_FILENAME), '{"fetchedAt":1,"skills":[{"id":"x"}]}');
    assert.equal(readManagedSkillsCache(cacheDir), null);
    assert.equal(isManagedSkill({ id: "a", name: "b", description: "c", body: "d" }), true);
    assert.equal(isManagedSkill({ id: "", name: "b", description: "c", body: "d" }), false);
    assert.equal(isManagedSkill({ id: "a", name: "b", description: "c", body: "" }), false);
  });
});

describe("the box, as the rest of the host sees it", () => {
  it("picks the message a failure becomes, and knows the executor that refuses", () => {
    assert.equal(boxNotReadyMessageForError(new SlateBoxNoMonitorAvailableError()), SLATE_BOX_NO_MONITOR_AVAILABLE_MESSAGE);
    assert.equal(boxNotReadyMessageForError(new SlateBoxDaemonUnreachableError("timeout", "timed out")), SLATE_BOX_NOT_RESPONDING_MESSAGE);
    assert.equal(boxNotReadyMessageForError(new SlateBoxDaemonUnreachableError("crash", "crashed")), SLATE_BOX_NOT_RESPONDING_MESSAGE);
    assert.equal(boxNotReadyMessageForError(new SlateBoxDaemonUnreachableError("refused", "refused")), SLATE_BOX_NOT_READY_MESSAGE);
    assert.equal(boxNotReadyMessageForError(new Error("anything")), SLATE_BOX_NOT_READY_MESSAGE);
    assert.match(SLATE_BOX_NOT_RESPONDING_MESSAGE, /Update Slate's Computer/);
    assert.equal(isNoMonitorComputerUseExecutor(noMonitorComputerUseExecutor), true);
    assert.equal(isNoMonitorComputerUseExecutor({}), false);
    assert.equal(isPrimaryWindowIndex(1), true);
    assert.equal(isPrimaryWindowIndex(2), false);
  });
});

describe("reporting the MCP servers an agent has", () => {
  it("groups the tools by the server they came from", async () => {
    const executor = createSlateMcpStateExecutor({
      getTools: async () => [
        { providerIdentifier: "linear", name: "issue", toolName: "linear_issue" },
        { providerIdentifier: "linear", name: "comment", toolName: "linear_comment" },
        { providerIdentifier: "slack", name: "post", toolName: "slack_post" },
      ],
    });
    const result = await executor.execute(context);
    assert.equal(result.result.case, "success");
    const servers = result.result.case === "success" ? result.result.value.servers : [];
    assert.deepEqual(servers.map((server) => server.serverIdentifier), ["linear", "slack"]);
    assert.deepEqual(servers.map((server) => server.status), ["connected", "connected"]);
    assert.deepEqual(servers[0]?.tools.map((tool) => tool.toolName), ["linear_issue", "linear_comment"]);
  });
});

describe("the skills that came from plugins", () => {
  it("keeps only safe ids and records that name a real file, and fills in what an older cache omitted", () => {
    assert.equal(isSafePluginSkillId("code-review"), true);
    assert.equal(isSafePluginSkillId("Code-Review"), false);
    assert.equal(isSafePluginSkillId("../escape"), false);
    const cacheDir = join(scratch, "plugin-skills");
    writePluginSkillsCache(cacheDir, {
      currentUserId: 7,
      skills: [{ id: "code-review", pluginId: "p1", pluginName: "Plug", name: "Code review", description: "reviews", filePath: "/plugins/p1/skills/code-review/SKILL.md" }],
    }, () => 11);
    const read = readPluginSkillsCache(cacheDir);
    assert.equal(read?.fetchedAt, 11);
    assert.equal(read?.currentUserId, 7);
    assert.equal(read?.skills[0]?.pluginVersion, "");
    assert.equal(read?.skills[0]?.installPath, "");
    assert.equal(read?.skills[0]?.publisherUserId, null);
    assert.deepEqual(read?.authBlocked, []);
    writeFileSync(join(cacheDir, "cache.json"), '{"fetchedAt":1,"skills":[{"id":"safe-id","pluginId":"p","pluginName":"P","name":"n","description":"d","filePath":"relative/path"}]}');
    assert.equal(readPluginSkillsCache(cacheDir), null);
    writeFileSync(join(cacheDir, "cache.json"), '{"fetchedAt":1,"skills":[{"id":"../escape","pluginId":"p","pluginName":"P","name":"n","description":"d","filePath":"/plugins/x"}]}');
    assert.equal(readPluginSkillsCache(cacheDir), null);
    assert.equal(readPluginSkillsCache(join(scratch, "nowhere")), null);
  });
});

describe("which platforms an automation listens to", () => {
  it("counts each platform once per automation and explains a scope the listener cannot see", () => {
    assert.equal(isListenerPlatform("slack"), true);
    assert.equal(isListenerPlatform("nonsense"), false);
    const counts = countListenerPlatforms([
      { isEnabled: true, trigger: { type: "group", listeners: [{ type: "slack" }, { type: "slack" }, { type: "github" }] } as never },
      { isEnabled: false, trigger: { type: "slack" } as never },
    ]);
    assert.deepEqual(counts, { github: 1, slack: 1 });
    assert.deepEqual(listenerPlatformsInTrigger({ type: "group", listeners: [{ type: "github" }, { type: "unknown" }] } as never), ["github"]);
    assert.equal(
      describeScopeIssues([{ kind: "bot-not-in-channel", scope: "#ops" }, { kind: "not-found", scope: "#ghost" }]),
      "Invite @Slate to #ops in Slack — messages there can't reach this listener until the bot joins. Couldn't find #ghost — check the name, or invite @Slate to it first if it's a private channel.",
    );
    assert.equal(describeScopeIssues([]), "");
  });
});

describe("searching an agent's transcript", () => {
  const entries: SearchableTranscriptEntry[] = [
    { id: "1", kind: "message", content: "the first note about widgets", role: "user", timestampMs: 10 },
    { id: "2", kind: "notice", text: "nothing here", timestampMs: 20 },
    { id: "3", kind: "message", content: "a second note about widgets", role: "assistant", timestampMs: 30 },
    { id: "4", kind: "message", content: "about widgets but hidden", role: "assistant", timestampMs: 40, hiddenOutboundAgentPeerMessage: true },
    { id: "5", kind: "send-message", message: { type: "text", content: "a third note about widgets" }, timestampMs: 50 },
  ];

  it("takes the newest matches first, skips what passed between agents, and bounds the count", () => {
    const matches = findAgentContentMatches(entries, "widgets");
    assert.deepEqual(matches.map((match) => match.entryId), ["5", "3", "1"]);
    assert.deepEqual(matches.map((match) => match.role), ["assistant", "assistant", "user"]);
    assert.deepEqual(matches.map((match) => match.timestampMs), [50, 30, 10]);
    assert.equal(findAgentContentMatches(entries, "widgets", 1).length, 1);
    assert.deepEqual(findAgentContentMatches(entries, ""), []);
    assert.deepEqual(findAgentContentMatches(entries, "absent"), []);
  });

  it("gives a snippet with a little of what surrounds the match", () => {
    assert.equal(buildContentSnippet("the note about widgets", "widgets"), "the note about widgets");
    assert.equal(buildContentSnippet(`${"x".repeat(50)}widgets`, "widgets"), `…${"x".repeat(30)}widgets`);
    assert.match(buildContentSnippet(`widgets${"y".repeat(80)}`, "widgets") ?? "", /^widgets.*…$/);
    assert.equal(buildContentSnippet("nothing", "widgets"), null);
    assert.equal(buildContentSnippet("anything", ""), null);
    assert.equal(entrySearchText({ id: "a", kind: "message", content: "text", role: "user" }), "text");
    assert.equal(entrySearchText({ id: "b", kind: "send-message", message: { type: "text", content: "sent" } }), "sent");
    assert.equal(entrySearchText({ id: "c", kind: "send-message", message: { type: "image" } }), "");
    assert.equal(entrySearchText({ id: "d", kind: "notice", text: "noticed" }), "noticed");
    assert.equal(entrySearchText({ id: "e", kind: "tool-call" }), "");
  });
});

describe("painting the box's wallpaper", () => {
  it("reads a tone plan only when it is exactly a tone and a number of seconds", () => {
    assert.deepEqual(parseTonePlan("dark 300\n"), { tone: "dark", msUntilNextBoundary: 300_000 });
    assert.equal(parseTonePlan("dark"), undefined);
    assert.equal(parseTonePlan("dark 300 extra"), undefined);
    assert.equal(parseTonePlan("Dark 300"), undefined);
    assert.equal(parseTonePlan("dark soon"), undefined);
  });

  it("ignores sockets that are not displays, and paints each live display as its owner", async () => {
    const socketDir = join(scratch, "x11");
    mkdirSync(socketDir, { recursive: true });
    writeFileSync(join(socketDir, "X0"), "");
    writeFileSync(join(socketDir, "not-a-display"), "");
    assert.deepEqual(await readLiveDisplays(socketDir), []);
    assert.deepEqual(await readLiveDisplays(join(scratch, "no-such-dir")), []);
    assert.deepEqual(asDisplayOwner({ uid: 501, gid: 20 }, () => 0, () => 20), { uid: 501, gid: 20 });
    assert.deepEqual(asDisplayOwner({ uid: 0, gid: 0 }, () => 0, () => 0), {});
    assert.deepEqual(asDisplayOwner({ uid: 501, gid: 20 }, () => 501, () => 20), {});
    const calls: string[] = [];
    const commands = createBoxWallpaperCommands({
      settingsPath: "/tmp/settings.json",
      log: (message) => { calls.push(message); },
      nodePath: "/usr/bin/node",
      toneScriptPath: "/usr/local/bin/slate-wallpaper-tone.mjs",
      wallpaperCommandPath: "/usr/local/bin/slate-wallpaper",
      xSocketDir: socketDir,
      exists: () => true,
      readDisplays: async () => [{ display: ":0", uid: 501, gid: 20 }, { display: ":1", uid: 501, gid: 20 }],
      runCommand: async (file, args) => { calls.push(`${file} ${args.join(" ")}`); return { stdout: args[0] === "/usr/local/bin/slate-wallpaper-tone.mjs" ? "light 60" : "" }; },
    });
    assert.equal(commands.isAvailable, true);
    assert.deepEqual(await commands.resolvePlan(), { tone: "light", msUntilNextBoundary: 60_000 });
    await commands.paint();
    assert.deepEqual(calls, [
      "/usr/bin/node /usr/local/bin/slate-wallpaper-tone.mjs /tmp/settings.json",
      "/usr/local/bin/slate-wallpaper paint :0",
      "/usr/local/bin/slate-wallpaper paint :1",
    ]);
    const failing = createBoxWallpaperCommands({
      settingsPath: "/tmp/settings.json",
      log: (message) => { calls.push(message); },
      toneScriptPath: "/missing/tone.mjs",
      wallpaperCommandPath: "/usr/local/bin/slate-wallpaper",
      exists: (path) => !path.startsWith("/missing"),
      readDisplays: async () => { throw new Error("no sockets"); },
      runCommand: async () => { throw new Error("helper is broken"); },
    });
    assert.equal(failing.isAvailable, false);
    assert.equal(await failing.resolvePlan(), undefined);
    await failing.paint();
    assert.match(calls.at(-1) ?? "", /wallpaper: reading live displays failed \(no sockets\)/);
  });
});

describe("an agent waiting for a connector to be authorized", () => {
  it("matches a completion by name or id, prefers the id, and forgets waits that outlived their time", () => {
    let nowMs = 1_000;
    const registry = new McpAuthWaitRegistry({ ttlMs: 100, now: () => nowMs });
    registry.register({ agentId: "a1", connector: "Linear" });
    registry.register({ agentId: "a2", connector: "Git Hub", serverId: "srv-2" });
    assert.equal(registry.take({ serverId: "srv-2", serverName: "github" }), "a2");
    assert.equal(registry.take({ serverId: "srv-2", serverName: "github" }), null);
    assert.equal(registry.take({ serverId: "other", serverName: "linear" }), "a1");
    registry.register({ agentId: "a3", connector: "", serverId: "srv-3" });
    assert.equal(registry.take({ serverId: "other", serverName: "srv-3" }), null);
    assert.equal(registry.take({ serverId: "srv-3", serverName: "" }), "a3");
    registry.register({ agentId: "a6", connector: "jira", serverId: "srv-6" });
    registry.register({ agentId: "a7", connector: "Jira" });
    assert.equal(registry.take({ serverId: "srv-6", serverName: "jira" }), "a7");
    registry.register({ agentId: "a4", connector: "sentry" });
    nowMs += 101;
    assert.equal(registry.take({ serverId: "other", serverName: "sentry" }), null);
  });
});

describe("a page that refused an automated visitor", () => {
  it("recognizes the families it knows and leaves anything else alone", () => {
    assert.deepEqual(classifyBotBlockPage({ url: "https://www.google.com/sorry/index", title: "" }), {
      family: "google_sorry",
      confidence: "high",
      blockedHost: "google.com",
      blockedUrl: "https://www.google.com/sorry/index",
    });
    assert.equal(classifyBotBlockPage({ url: "https://example.com/", title: "Just a moment..." })?.family, "cloudflare_challenge");
    assert.equal(classifyBotBlockPage({ url: "https://example.com/", title: "Access Denied" })?.confidence, "low");
    assert.equal(classifyBotBlockPage({ url: "https://example.com/normal", title: "Welcome" }), undefined);
    assert.equal(classifyBotBlockPage({ url: "not a url", title: "" }), undefined);
  });

  it("audits the navigation before it reports what it noticed", () => {
    const order: string[] = [];
    const auditor = withBotBlockDetection(
      { record: () => { order.push("audited"); } },
      (hit) => { order.push(`blocked by ${hit.family}`); },
    );
    auditor.record({ action: { kind: "browserNavigation", url: "https://www.google.com/sorry/index", pageTitle: "" } });
    auditor.record({ action: { kind: "browserNavigation", url: "https://example.com/", pageTitle: "Welcome" } });
    auditor.record({ action: { kind: "shellCommand" } });
    assert.deepEqual(order, ["audited", "blocked by google_sorry", "audited", "audited"]);
  });
});

describe("a database another process holds", () => {
  it("tells a busy database from a broken one, and waits out only the busy one", async () => {
    const busy = Object.assign(new Error("database is locked"), { errcode: SQLITE_BUSY });
    assert.equal(isSqliteBusyError(busy), true);
    assert.equal(isSqliteBusyError(new Error("database table is locked")), true);
    assert.equal(isSqliteBusyError(new Error("something else")), false);
    assert.equal(isSqliteBusyError("locked"), false);
    assert.equal(isSqliteIoError(Object.assign(new Error("x"), { errcode: 10 })), true);
    assert.equal(isSqliteIoError(new Error("disk I/O error")), true);
    assert.equal(isSqliteCorruptError(new Error("database disk image is malformed")), true);
    assert.equal(isSqliteCorruptError(new Error("file is not a database")), true);
    assert.equal(isSqliteCorruptError(busy), false);
    const waits: number[] = [];
    let attempts = 0;
    const value = await retrySqliteBusy(async () => { attempts += 1; if (attempts < 3) throw busy; return "done"; }, { baseDelayMs: 10, delay: async (ms) => { waits.push(ms); } });
    assert.equal(value, "done");
    assert.deepEqual(waits, [10, 20]);
    let brokenAttempts = 0;
    await assert.rejects(
      () => retrySqliteBusy(async () => { brokenAttempts += 1; throw new Error("malformed"); }, { delay: async () => {} }),
      /malformed/,
    );
    assert.equal(brokenAttempts, 1);
    await assert.rejects(() => retrySqliteBusy(async () => { throw busy; }, { attempts: 2, delay: async () => {} }), /database is locked/);
  });
});

describe("what a turn cost", () => {
  it("clamps wide counts, reports nothing when there is nothing, and adds the kinds up", () => {
    assert.equal(toSafeTokenCount(-1n), 0);
    assert.equal(toSafeTokenCount(7n), 7);
    assert.equal(toSafeTokenCount(BigInt(Number.MAX_SAFE_INTEGER) + 1n), Number.MAX_SAFE_INTEGER);
    assert.equal(turnUsageFromTurnEnded({}), undefined);
    const usage = turnUsageFromTurnEnded({ inputTokens: 10n, outputTokens: 2n, cacheReadTokens: 3n, cacheWriteTokens: 4n });
    assert.deepEqual(usage, { inputTokens: 10, outputTokens: 2, cacheReadTokens: 3, cacheWriteTokens: 4 });
    const withReasoning = turnUsageFromTurnEnded({ reasoningTokens: 5n });
    assert.deepEqual(withReasoning, { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0, reasoningTokens: 5 });
    const merged = mergeTurnUsage(usage, withReasoning);
    assert.deepEqual(merged, { inputTokens: 10, outputTokens: 2, cacheReadTokens: 3, cacheWriteTokens: 4, reasoningTokens: 5 });
    assert.equal(mergeTurnUsage(undefined, usage), usage);
    assert.equal(mergeTurnUsage(usage, undefined), usage);
    const a: TurnUsage = { inputTokens: Number.MAX_SAFE_INTEGER, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0 };
    assert.equal(mergeTurnUsage(a, a)?.inputTokens, Number.MAX_SAFE_INTEGER);
  });
});

describe("the triggers a backend can raise", () => {
  it("describes each platform's events in the shape the automation model holds", () => {
    const linear = backendCloudTrigger({
      type: "linear",
      event: { case: "statusChanged", statusIds: ["s1"] },
      projectIds: ["p1"],
      teamIds: ["t1"],
    } as never);
    assert.equal(linear.trigger.case, "linear");
    assert.deepEqual((linear.trigger.value as { event: { case: string } }).event.case, "statusChanged");
    const unknown = backendCloudTrigger({ type: "sentry", event: { case: "somethingElse" }, projectIds: [] } as never);
    assert.equal(unknown.trigger.case, "sentry");
    assert.equal((unknown.trigger.value as { event: { case: string | undefined } }).event.case, undefined);
    const teams = backendCloudTrigger({ type: "microsoftTeams", tenantId: "t", teamId: "tm", teamIds: [], channelIds: [], messageContains: "x", messageContainsIsRegex: false, blockUnauthenticatedTeamsUsers: true } as never);
    assert.equal(teams.trigger.case, "microsoftTeamsTrigger");
    assert.equal(backendCloudTrigger({ type: "pagerduty", event: { case: "incidentAny" }, serviceIds: [] } as never).trigger.case, "pagerduty");
  });
});

describe("telling an agent its own profile changed", () => {
  it("renders a marked update, finds the newest one, and reuses a snapshot of the same epoch", () => {
    const identity = { name: "Researcher", description: "digs into things" };
    const update = renderAgentProfileUpdate(identity);
    assert.match(update, /^\[SLATE_HIDDEN_PROMPT\]<<SLATE_AGENT_PROFILE_UPDATE:v1:[A-Za-z0-9_-]+>>/);
    assert.match(update, /<agent_profile_update>/);
    assert.match(update, /Current name: Researcher/);
    assert.deepEqual(parseLatestAgentProfileUpdate(update), identity);
    const later = renderAgentProfileUpdate({ name: "Analyst", description: "  weighs things  " });
    assert.deepEqual(parseLatestAgentProfileUpdate(`${update}\n${later}`), { name: "Analyst", description: "weighs things" });
    assert.equal(parseLatestAgentProfileUpdate("no update here"), null);
    assert.equal(parseLatestAgentProfileUpdate(`${SLATE_AGENT_PROFILE_UPDATE_MARKER}!!!>>`), null);
    assert.deepEqual(parseLatestAgentProfileUpdate(`${update}\n${SLATE_AGENT_PROFILE_UPDATE_MARKER}truncated`), identity);
    assert.deepEqual(normalizeAgentProfileIdentity({ name: "  a  ", description: " b " }), { name: "a", description: "b" });
    assert.equal(agentProfileIdentitiesEqual(identity, { ...identity }), true);
    assert.equal(agentProfileIdentitiesEqual(identity, { name: "Other", description: identity.description }), false);
    const snapshot = resolveAgentProfilePromptSnapshot({ compactionEpoch: 3, profileSection: "section", identity });
    assert.equal(snapshot.announcedIdentity, identity);
    assert.equal(resolveAgentProfilePromptSnapshot({ snapshot, compactionEpoch: 3, profileSection: "changed", identity: { name: "x", description: "y" } }), snapshot);
    assert.notEqual(resolveAgentProfilePromptSnapshot({ snapshot, compactionEpoch: 4, profileSection: "changed", identity: { name: "x", description: "y" } }), snapshot);
  });
});

describe("where a box's store lives", () => {
  it("prefers a local directory, then the backend's store, and falls back to the agent store", () => {
    assert.equal(resolveBackendKind("/tmp/store", {}), "local-fs");
    assert.equal(resolveBackendKind(undefined, { [SLATE_BOX_STORE_BACKEND_ENV]: " V2 " }), "slate-box-store-v2");
    assert.equal(resolveBackendKind(undefined, { [SLATE_BOX_STORE_BACKEND_ENV]: "v1" }), "agent-store");
    assert.equal(resolveBackendKind(undefined, {}), "agent-store");
    const env: Record<string, string | undefined> = { [SLATE_BOX_STORE_LOCAL_DIR_ENV]: "/tmp/store", SLATE_BOX_STORE_SYNC: "yes", SLATE_BOX_STORE_COPY_IN: "0" };
    const policy = getBoxStoreBackendPolicy(env);
    assert.deepEqual(policy, { kind: "local-fs", localDir: "/tmp/store" });
    assert.equal(getBoxStoreBackendPolicy(env), policy);
    assert.equal(isBoxStoreSyncEnabled(env), true);
    assert.equal(isBoxStoreCopyInEnabled(env), false);
    assert.deepEqual(getBoxStoreBackendPolicy({ [SLATE_BOX_STORE_LOCAL_DIR_ENV]: "relative/path" }), { kind: "agent-store" });
  });
});

describe("knowing a box's store was hydrated", () => {
  it("accepts evidence that says the store is complete, and names the hand-off marker", () => {
    assert.equal(BOX_STORE_HYDRATION_HANDOFF_MANIFEST_PATH, "home/box/slate-data/.box-store-legacy-hydration-complete");
    assert.equal(isHydrationHandoffManifestPath(BOX_STORE_HYDRATION_HANDOFF_MANIFEST_PATH), true);
    assert.equal(isHydrationHandoffManifestPath(`${BOX_STORE_HYDRATION_HANDOFF_MANIFEST_PATH}.123.tmp`), true);
    assert.equal(isHydrationHandoffManifestPath("home/box/slate-data/other"), false);
    assert.equal(isBoxStoreFullyHydrated(undefined), false);
    assert.equal(isBoxStoreFullyHydrated({ failures: [new Error("x")] }), false);
    assert.equal(isBoxStoreFullyHydrated({ failures: [], manifestEntries: 2, files: 2, verified: 2 }), true);
    assert.equal(isBoxStoreFullyHydrated({ failures: [], manifestEntries: 2, files: 1, verified: 2 }), false);
    assert.equal(isBoxStoreFullyHydrated({ failures: [], manifestEntries: 0, files: 0, verified: 0 }), true);
    assert.equal(isBoxStoreFullyHydrated({ failures: [], manifestEntries: 2, files: 2, verified: 2, hydrateSource: "legacy", authoritativeStoreDbEntries: 5, restoredStoreDbEntries: 5 }), true);
    assert.equal(isBoxStoreFullyHydrated({ failures: [], manifestEntries: 2, files: 2, verified: 2, hydrateSource: "legacy", authoritativeStoreDbEntries: 5, restoredStoreDbEntries: 4 }), false);
  });

  it("writes the marker atomically and removes it without leaving anything behind", async () => {
    const markerPath = join(scratch, "box-data", ".box-store-legacy-hydration-complete");
    await writeHydrationHandoffMarker(markerPath);
    assert.equal(readFileSync(markerPath, "utf8"), "complete\n");
    assert.deepEqual(readdirSync(join(scratch, "box-data")), [".box-store-legacy-hydration-complete"]);
    await removeHydrationHandoffMarker(markerPath);
    assert.deepEqual(readdirSync(join(scratch, "box-data")), []);
    await removeHydrationHandoffMarker(markerPath);
  });
});

describe("the frames the codebase-telemetry helper speaks", () => {
  it("frames a payload with its length, and reads back only whole frames", () => {
    const frame = encodeFrame(Buffer.from("hi"));
    assert.equal(frame.readUInt32BE(0), 2);
    assert.deepEqual(decodeFramePayloads(frame), { payloads: [Buffer.from("hi")], remainder: Buffer.alloc(0) });
    const two = Buffer.concat([frame, frame]);
    assert.deepEqual(decodeFramePayloads(two).payloads.map((payload) => payload.toString()), ["hi", "hi"]);
    const partial = Buffer.concat([two, Buffer.from([0, 0])]);
    assert.equal(decodeFramePayloads(partial).payloads.length, 2);
    assert.deepEqual(decodeFramePayloads(partial).remainder, Buffer.from([0, 0]));
    assert.throws(() => encodeFrame(Buffer.alloc(MAX_FRAME_BYTES + 1)), CsnapsProtocolError);
    assert.throws(() => decodeFramePayloads(Buffer.from([0x00, 0x20, 0x00, 0x00])), CsnapsProtocolError);
  });

  it("writes a request and reads a response, refusing envelopes that do not hold what they should", () => {
    const request = encodeCsnapsRequest(3, { method: "snapshot", params: {} });
    assert.deepEqual(JSON.parse(decodeFramePayloads(request).payloads[0]!.toString()), { id: 3, method: "snapshot", params: {} });
    assert.deepEqual(JSON.parse(decodeFramePayloads(encodeCsnapsRequest(4, { method: "initialize", params: { root: "/w" } })).payloads[0]!.toString()), { id: 4, method: "initialize", params: { root: "/w" } });
    assert.throws(() => encodeCsnapsRequest(-1, { method: "ping" }), CsnapsProtocolError);
    assert.deepEqual(parseCsnapsResponse(Buffer.from('{"id":1,"ok":true,"result":{}}')), { id: 1, ok: true, result: {} });
    assert.deepEqual(parseCsnapsResponse(Buffer.from('{"id":2,"ok":false,"error":"server_busy"}')), { id: 2, ok: false, error: "server_busy" });
    assert.throws(() => parseCsnapsResponse(Buffer.from("not json")), CsnapsProtocolError);
    assert.throws(() => parseCsnapsResponse(Buffer.from('{"id":1,"ok":true}')), CsnapsProtocolError);
    assert.throws(() => parseCsnapsResponse(Buffer.from('{"id":1,"ok":true,"result":{},"extra":1}')), CsnapsProtocolError);
    assert.throws(() => parseCsnapsResponse(Buffer.from('{"id":1,"ok":false,"error":"made_up"}')), CsnapsProtocolError);
  });

  it("decodes a stream across chunks and refuses to call a truncated stream complete", () => {
    const decoder = new CsnapsResponseDecoder();
    const frame = encodeFrame(Buffer.from('{"id":9,"ok":true,"result":{}}'));
    assert.deepEqual(decoder.decode(frame.subarray(0, 3)), []);
    assert.deepEqual(decoder.decode(frame.subarray(3)), [{ id: 9, ok: true, result: {} }]);
    decoder.assertComplete();
    decoder.decode(frame.subarray(0, 5));
    assert.throws(() => decoder.assertComplete(), CsnapsProtocolError);
  });

  it("checks what each operation answered with", () => {
    assert.deepEqual(parseCsnapsOperationResult({ method: "ping" }, {}), {});
    assert.throws(() => parseCsnapsOperationResult({ method: "ping" }, { unexpected: 1 }), CsnapsProtocolError);
    const tracked = { codebaseUuid: "123e4567-e89b-42d3-a456-426614174000", path: "/w", kind: 1, environment: 2 };
    assert.deepEqual(parseCsnapsOperationResult({ method: "initialize", params: {} }, { state: { tracked: [tracked] } }), { state: { tracked: [tracked] } });
    assert.throws(() => parseCsnapsOperationResult({ method: "initialize", params: {} }, { state: { tracked: [{ ...tracked, codebaseUuid: "not-a-uuid" }] } }), CsnapsProtocolError);
    assert.deepEqual(parseCsnapsOperationResult({ method: "apply_codebase_specs", params: {} }, { state: { tracked: [] }, rejected: [{ path: "/x", kind: 3 }] }), { state: { tracked: [] }, rejected: [{ path: "/x", kind: 3 }] });
    assert.throws(() => parseCsnapsOperationResult({ method: "apply_codebase_specs", params: {} }, { state: { tracked: [] } }), CsnapsProtocolError);
  });
});

describe("what a failed local-exec operation failed at", () => {
  it("tells a missing program from a refused one, and leaves everything else as other", () => {
    assert.deepEqual(classifyLocalExecFailure("spawn /usr/bin/thing ENOENT"), { errorClass: "spawn_enoent", errno: "ENOENT" });
    assert.deepEqual(classifyLocalExecFailure("spawnSync sh EACCES"), { errorClass: "spawn_permissions", errno: "EACCES" });
    assert.deepEqual(classifyLocalExecFailure("spawn sh EPERM"), { errorClass: "spawn_permissions", errno: "EPERM" });
    assert.deepEqual(classifyLocalExecFailure("spawn failed"), { errorClass: "spawn_other" });
    assert.deepEqual(classifyLocalExecFailure("spawn failed with E2BIG"), { errorClass: "spawn_other", errno: "E2BIG" });
    assert.deepEqual(classifyLocalExecFailure("connection reset"), { errorClass: "other" });
    assert.deepEqual(classifyLocalExecFailure("connection reset with ENOTCONN"), { errorClass: "other", errno: "ENOTCONN" });
  });
});

describe("which files of a workspace the store leaves alone", () => {
  it("reads patterns, ignores what they match, and keeps a directory a negation could reach", () => {
    assert.deepEqual(parseIgnorePatterns("# comment\nnode_modules/\n\n  \ndist  \n"), ["node_modules/", "dist"]);
    assert.equal(IGNORE_NOTHING.ignores("anything"), false);
    assert.equal(IGNORE_NOTHING.canPruneDir("anything"), false);
    const ignore = compileWorkspaceIgnore(["node_modules/", "*.log", "/build", "!build/keep.log"]);
    assert.equal(ignore.ignores("node_modules/pkg/index.js"), true);
    assert.equal(ignore.ignores("a/b/app.log"), true);
    assert.equal(ignore.ignores("build/out.js"), true);
    assert.equal(ignore.ignores("src/build/out.js"), false);
    assert.equal(ignore.ignores("build/keep.log"), false);
    assert.equal(ignore.canPruneDir("node_modules"), true);
    assert.equal(ignore.canPruneDir("build"), false);
    assert.equal(ignore.canPruneDir("src"), false);
    assert.equal(negationReaches({ everywhere: true, literalPrefix: "" }, "anywhere"), true);
    assert.equal(negationReaches({ everywhere: false, literalPrefix: "build" }, "build"), true);
    assert.equal(negationReaches({ everywhere: false, literalPrefix: "build/keep.log" }, "build"), true);
    assert.equal(negationReaches({ everywhere: false, literalPrefix: "other" }, "build"), false);
    assert.equal(negationReaches(undefined, "build"), false);
  });

  it("uses the workspace's own ignore file on top of the defaults", () => {
    const workspace = join(scratch, "workspace");
    mkdirSync(workspace, { recursive: true });
    writeFileSync(join(workspace, ".slateignore"), "# ours\nsecrets/\n");
    const ignore = loadWorkspaceIgnore(workspace);
    assert.equal(ignore.ignores("secrets/token"), true);
    assert.equal(ignore.ignores("node_modules/pkg"), true);
    assert.equal(ignore.ignores("src/index.ts"), false);
    const empty = loadWorkspaceIgnore(join(scratch, "no-workspace"), []);
    assert.equal(empty.ignores("anything"), false);
  });
});
