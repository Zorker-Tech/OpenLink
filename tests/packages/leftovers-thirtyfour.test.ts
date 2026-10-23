/**
 * The coordinator's gateway client and what the host's gateway exposes to it.
 */

import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { CoordinatorGatewayClient, CREATE_AGENT_RETRY_POLICY, GatewayEndpointChangedError, HOST_ACCOUNT_SLOT, PERMANENT_REFUSAL_KINDS, PRE_DISPATCH_KINDS } from "../../source/coordinator/gateway/gateway-client.ts";
import { CREATE_AGENT_NONCE_LEDGER_CAP, createHostGatewayApi, DISABLE_SEND_ACCEPT_RETURN_ENV, HOST_CAPABILITIES } from "../../source/gateway/host-gateway-api.ts";

describe("the client the coordinator speaks to the gateway with", () => {
  it("names the account slot it files itself under and the kinds it refuses early", () => {
    assert.equal(HOST_ACCOUNT_SLOT, "host");
    assert.equal(typeof PERMANENT_REFUSAL_KINDS, "object");
    assert.equal(typeof PRE_DISPATCH_KINDS, "object");
    assert.equal(typeof CREATE_AGENT_RETRY_POLICY, "object");
    assert.equal(typeof CoordinatorGatewayClient, "function");
    assert.equal(typeof GatewayEndpointChangedError, "function");
  });
});

describe("what the host's gateway exposes", () => {
  it("lists the capabilities this host offers, and bounds the nonce ledger it keeps", () => {
    assert.deepEqual([...HOST_CAPABILITIES], ["orderedReplicasV1", "sendAcceptanceV1"]);
    assert.equal(CREATE_AGENT_NONCE_LEDGER_CAP, 64);
    assert.equal(DISABLE_SEND_ACCEPT_RETURN_ENV, "SLATE_DISABLE_SEND_ACCEPT_RETURN");
    assert.equal(typeof createHostGatewayApi, "function");
  });
});

// ---------------------------------------------------------------------------------------------
// The method table the host exposes
// ---------------------------------------------------------------------------------------------

type Call = [string, string, unknown[]];
const argAt = (call: Call | undefined, index: number): any => ((call?.[2] ?? []) as any[])[index];

/** Every extension the gateway reaches for, recording each call and answering a sensible default. */
function gatewayWorld() {
  const calls: Call[] = [];
  const events: unknown[][] = [];
  const leaf = (owner: string, name: string, impl?: (...args: any[]) => any) => (...args: unknown[]) => {
    calls.push([owner, name, args]);
    return impl === undefined ? owner + "." + name : impl(...args);
  };
  const transcript: Record<string, unknown> = {
    createAgent: leaf("transcript", "createAgent", () => ({ agent: { id: "minted" } })),
    getActiveAgentId: leaf("transcript", "getActiveAgentId", () => "active"),
    listAgentsSync: leaf("transcript", "listAgentsSync", () => [{ id: "active", isGroup: false }, { id: "group", isGroup: true }]),
    switchAgent: leaf("transcript", "switchAgent", () => ({ entries: [] })),
    openAgentWindowed: leaf("transcript", "openAgentWindowed", () => ({ entries: [{ id: "entry" }] })),
    openAgentTail: leaf("transcript", "openAgentTail", () => ({ entries: [] })),
    getAgentTranscript: leaf("transcript", "getAgentTranscript", () => ({ entries: [] })),
    getAgentTranscriptPage: leaf("transcript", "getAgentTranscriptPage", () => ({ entries: [] })),
    getAgentTranscriptWindow: leaf("transcript", "getAgentTranscriptWindow", () => ({ entries: [] })),
    getAgentTranscriptTail: leaf("transcript", "getAgentTranscriptTail", () => ({ entries: [] })),
    getAgentThread: leaf("transcript", "getAgentThread", () => ({ entries: [] })),
    ensureLoaded: leaf("transcript", "ensureLoaded", () => ({ entries: [] })),
    sendPrompt: leaf("transcript", "sendPrompt"),
    searchAgents: leaf("transcript", "searchAgents", () => [{ id: "found" }]),
    searchMedia: leaf("transcript", "searchMedia", () => [{ id: "media" }]),
    deleteAgent: leaf("transcript", "deleteAgent", () => ({ transcript: [] })),
    deleteAgents: leaf("transcript", "deleteAgents", () => ({ transcript: [] })),
    getAgentAutomations: leaf("transcript", "getAgentAutomations", () => []),
    createAgentAutomation: leaf("transcript", "createAgentAutomation", () => [{ id: "new" }]),
    createAgentWorkflow: leaf("transcript", "createAgentWorkflow", () => [{ id: "workflow" }]),
    broadcastToAgents: leaf("transcript", "broadcastToAgents", () => ({ total: 2, scheduled: 2 })),
    connectChannel: leaf("transcript", "connectChannel", () => true),
    disconnectChannel: leaf("transcript", "disconnectChannel", () => true),
    setAgentAvatarBytes: leaf("transcript", "setAgentAvatarBytes", () => ({ id: "a" })),
    quiesceForRecreate: leaf("transcript", "quiesceForRecreate", () => ({ quiesced: true })),
    resumeAfterRecreate: leaf("transcript", "resumeAfterRecreate", () => ({ resumed: true })),
    promptAcceptanceStatus: leaf("transcript", "promptAcceptanceStatus", () => ({ status: "pending" })),
    listAgents: leaf("transcript", "listAgents", () => []),
    countAgentsOnDisk: leaf("transcript", "countAgentsOnDisk", () => 0),
  };
  const executor = { execute: leaf("mcp-executor", "execute", () => ({ result: "executed" })) };
  const mcp = {
    mcp: {
      listTools: leaf("mcp", "listTools", () => [
        { name: "tool", providerIdentifier: "p", toolName: "read", description: "described", inputSchema: { toJson: () => ({ schema: 1 }) } },
        { name: "second", providerIdentifier: "p", toolName: "write" },
      ]),
      createExecutor: leaf("mcp", "createExecutor", () => executor),
    },
    syncPluginSkills: leaf("mcp", "syncPluginSkills"),
    pluginSyncStatus: leaf("mcp", "pluginSyncStatus"),
    skillPublish: { listTargets: leaf("mcp.skillPublish", "listTargets"), publish: leaf("mcp.skillPublish", "publish"), resync: leaf("mcp.skillPublish", "resync"), unpublish: leaf("mcp.skillPublish", "unpublish") },
    management: { restart: leaf("mcp.management", "restart") },
    listBoxServers: leaf("mcp", "listBoxServers", (ids: string[]) => ids.map((serverIdentifier) => ({ serverIdentifier, status: "ok", ...(serverIdentifier === "withdetail" ? { statusDetail: "detail" } : {}), toolCount: 2 }))),
  };
  const analytics = { markActive: leaf("telemetry.analytics", "markActive"), trackEvent: leaf("telemetry.analytics", "trackEvent") };
  const sharing: Record<string, unknown> = {};
  for (const name of ["createRoomFromAgent", "createRoomInvite", "joinSharedRoom", "respondToRoomJoinRequest", "createSharedRoom", "addOwnAgentToSharedRoom", "removeOwnAgentFromSharedRoom", "leaveSharedRoom"]) sharing[name] = leaf("cross-user-sharing", name, () => ({ done: name }));
  sharing.getSharingState = leaf("cross-user-sharing", "getSharingState");
  sharing.setSharedRoomTyping = leaf("cross-user-sharing", "setSharedRoomTyping");
  sharing.noteAgentDeleted = leaf("cross-user-sharing", "noteAgentDeleted");
  sharing.resumeAfterRecreate = leaf("cross-user-sharing", "resumeAfterRecreate");
  const automations = {
    getAgentChannels: leaf("automations", "getAgentChannels", () => [{ platform: "slack" }]),
    getListenerIntegrations: leaf("automations", "getListenerIntegrations"),
    getListenerConnectUrl: leaf("automations", "getListenerConnectUrl", () => "https://connect"),
    deleteAgentSchedules: leaf("automations", "deleteAgentSchedules", async () => true),
    suspendWakes: leaf("automations", "suspendWakes"),
    resumeWakes: leaf("automations", "resumeWakes"),
  };
  const foreverBox = {
    getStatus: leaf("forever-box", "getStatus", () => ({ state: "present" })),
    ensure: leaf("forever-box", "ensure", () => ({ state: "present" })),
    reset: leaf("forever-box", "reset", () => ({ state: "absent" })),
    update: leaf("forever-box", "update", () => ({ state: "present" })),
    autoUpdateNow: leaf("forever-box", "autoUpdateNow"),
    setMigrating: leaf("forever-box", "setMigrating"),
  };
  const registry: Record<string, unknown> = {
    transcript,
    attachments: { upload: leaf("attachments", "upload"), readImage: leaf("attachments", "readImage"), readText: leaf("attachments", "readText"), readChunk: leaf("attachments", "readChunk") },
    automations,
    "managed-setup": { skillsCatalog: leaf("managed-setup", "skillsCatalog") },
    settings: { getHostSettings: leaf("settings", "getHostSettings"), setHostSettings: leaf("settings", "setHostSettings", () => ({ saved: true })) },
    "local-tool-permission": { resolveAsk: leaf("local-tool-permission", "resolveAsk"), notePermissionChanged: leaf("local-tool-permission", "notePermissionChanged") },
    telemetry: { analytics, logs: { reportAgentOpen: leaf("telemetry.logs", "reportAgentOpen") }, noteSlateModelExperimentActive: leaf("telemetry", "noteSlateModelExperimentActive"), reportMessageSent: leaf("telemetry", "reportMessageSent") },
    "cross-user-sharing": sharing,
    "content-search": { isEnabled: () => true },
    "auto-review": { resolveApproval: leaf("auto-review", "resolveApproval", () => ({ resolved: true })) },
    session: { forgetHandoff: leaf("session", "forgetHandoff"), endHandoff: leaf("session", "endHandoff") },
    experiments: { isAgentNetworkEnabled: leaf("experiments", "isAgentNetworkEnabled") },
    "forever-box": foreverBox,
    "cloud-agents": { getInfo: leaf("cloud-agents", "getInfo") },
    "box-store-sync": { snapshotBoxStoreNow: leaf("box-store-sync", "snapshotBoxStoreNow"), getBoxStoreStatus: leaf("box-store-sync", "getBoxStoreStatus"), clearBoxStoreNow: leaf("box-store-sync", "clearBoxStoreNow") },
    "host-upgrade": { updateHostNow: leaf("host-upgrade", "updateHostNow"), getVersionState: leaf("host-upgrade", "getVersionState", () => ({ version: "1.0.0" })) },
    "teach-recording": { start: leaf("teach-recording", "start"), stop: leaf("teach-recording", "stop"), getStatus: leaf("teach-recording", "getStatus") },
    trays: { list: leaf("trays", "list", () => []), dismiss: leaf("trays", "dismiss", () => []), clearAll: leaf("trays", "clearAll", () => []) },
    "webauthn-proxy": { applyEnablement: leaf("webauthn-proxy", "applyEnablement"), requestCeremony: leaf("webauthn-proxy", "requestCeremony") },
    secrets: { set: leaf("secrets", "set"), getStatus: leaf("secrets", "getStatus") },
    mcp,
  };
  const deps = {
    extensions: { api: (id: string) => registry[id] },
    hostEvents: { emit: (event: unknown) => events.push(["emit", event]) },
    rosterBookkeeping: { latestActiveAgentId: "latest" },
    decorateForeverBoxStatus: (status: Record<string, unknown>) => ({ ...status, decorated: true }),
    getHealth: () => ({ isBusy: true }),
    kickstartIfPending: async (id: string) => { events.push(["kickstart", id]); return true; },
    requestDiskSaverAudit: async (id: string) => { events.push(["audit", id]); return false; },
    releaseAgentBox: async (id: string) => { events.push(["release", id]); },
    handleDesktopMcpAuthCompletion: async (completion: unknown) => { events.push(["auth", completion]); },
    forgetLocalToolPermission: (id: string) => { events.push(["forgetPermission", id]); },
    now: () => 1_000,
  };
  const named = (owner: string, name: string) => calls.filter((call) => call[0] === owner && call[1] === name);
  const argAt = (call: Call | undefined, index: number): any => ((call?.[2] ?? []) as any[])[index];
  const api = createHostGatewayApi(deps as never) as any;
  return { api, calls, events, named, registry, deps };
}

describe("the host gateway's method table", () => {
  it("mints an agent with what was asked, a real purpose and a shaped template", async () => {
    const world = gatewayWorld();
    const result = await world.api.createAgent({ name: "N", description: "D", title: "T", avatarShape: "circle", avatarColor: "red", origin: "background", purpose: "disk-saver", templateId: "valid-template-1", isIntroductionSuppressed: true, isKickstartRequested: true });
    assert.deepEqual(result, { agent: { id: "minted" } });
    assert.deepEqual(world.named("transcript", "createAgent")[0]?.[2], [
      { name: "N", description: "D", title: "T", avatarShape: "circle", avatarColor: "red" },
      "background",
      { isIntroductionSuppressed: true, isKickstartRequested: true, purpose: "disk-saver" },
    ]);
    assert.deepEqual(world.named("telemetry.analytics", "markActive")[0]?.[2], ["user_action"]);
    assert.deepEqual(world.named("telemetry.analytics", "trackEvent")[0]?.[2], ["slate.agent.created", { agent_id: "minted", origin: "background", template_id: "valid-template-1" }]);
    // An unknown purpose is dropped, and a template id that is not one is dropped too.
    const plain = gatewayWorld();
    await plain.api.createAgent({ name: "N", description: "D", purpose: "other", templateId: "Not A Template!" });
    assert.deepEqual(plain.named("transcript", "createAgent")[0]?.[2], [{ name: "N", description: "D" }, undefined, { isIntroductionSuppressed: false, isKickstartRequested: false }]);
    assert.deepEqual(plain.named("telemetry.analytics", "trackEvent")[0]?.[2], ["slate.agent.created", { agent_id: "minted", origin: "user" }]);
  });

  it("mints once per nonce, forgets a failed mint and bounds the ledger", async () => {
    const world = gatewayWorld();
    const first = world.api.createAgent({ name: "N", clientNonce: "same" });
    const second = world.api.createAgent({ name: "N", clientNonce: "same" });
    assert.equal(first, second);
    await first;
    // A mint that fails is not remembered, so the next call tries again.
    let attempts = 0;
    const failing = { ...world.deps.extensions.api("transcript") as object } as Record<string, unknown>;
    failing.createAgent = async () => { attempts += 1; throw new Error("mint failed"); };
    const failsWorld = gatewayWorld();
    failsWorld.registry.transcript = failing;
    const failingApi = createHostGatewayApi(failsWorld.deps as never) as any;
    await assert.rejects(() => failingApi.createAgent({ name: "N", clientNonce: "retry" }));
    await assert.rejects(() => failingApi.createAgent({ name: "N", clientNonce: "retry" }));
    assert.equal(attempts, 2);
    // The ledger keeps at most its cap of pending mints; the oldest is forgotten first.
    const capped = gatewayWorld();
    const cappedApi = createHostGatewayApi(capped.deps as never) as any;
    for (let index = 0; index < CREATE_AGENT_NONCE_LEDGER_CAP + 5; index += 1) await cappedApi.createAgent({ name: "N", clientNonce: "n" + index });
    const before = capped.named("transcript", "createAgent").length;
    await cappedApi.createAgent({ name: "N", clientNonce: "n0" });
    assert.equal(capped.named("transcript", "createAgent").length, before + 1);
  });

  it("opens an agent on screen, in a window or at its tail, and kicks it off", async () => {
    const world = gatewayWorld();
    assert.deepEqual(await world.api.openAgent({ id: "active" }), { entries: [] });
    assert.deepEqual(await world.api.openAgentWindowed({ id: "other", limit: 5 }), { entries: [{ id: "entry" }] });
    assert.deepEqual(await world.api.openAgentTail({ id: "third" }), { entries: [] });
    assert.deepEqual(world.named("transcript", "switchAgent")[0]?.[2], ["active"]);
    assert.deepEqual(world.named("transcript", "openAgentWindowed")[0]?.[2], ["other", 5]);
    assert.deepEqual(world.named("telemetry.logs", "reportAgentOpen").map((call) => call[2][0]), [
      { conversationId: "active", durationMs: 0, entryCount: undefined, wasActive: true },
      { conversationId: "other", durationMs: 0, entryCount: 1, wasActive: false },
      { conversationId: "third", durationMs: 0, entryCount: 0, wasActive: false },
    ]);
    assert.deepEqual(world.events.filter((event) => event[0] === "kickstart").map((event) => event[1]), ["active", "other", "third"]);
  });

  it("sends a prompt to the agent it was given, or the one on screen, with the acceptance switch", async () => {
    const world = gatewayWorld();
    assert.deepEqual(await world.api.sendPrompt({ agentId: "given", prompt: "hi" }), { accepted: true });
    assert.deepEqual(world.named("transcript", "sendPrompt")[0]?.[2]?.[1], { agentId: "given", directAddressedAcceptance: undefined, attachmentPaths: [], attachmentNames: [], richText: undefined, replyToId: undefined, clientNonce: undefined, isFork: undefined, traceparent: undefined, enterEpochMs: undefined, composedAtMs: undefined, awaitTurn: false });
    assert.deepEqual(argAt(world.named("telemetry", "reportMessageSent")[0], 0).agentId, "given");
    // With no agent id, the active agent, then the roster's latest, then "unknown".
    const noActive = gatewayWorld();
    (noActive.registry.transcript as Record<string, unknown>).getActiveAgentId = () => undefined;
    const fallbackApi = createHostGatewayApi(noActive.deps as never) as any;
    await fallbackApi.sendPrompt({ prompt: "hello" });
    assert.equal(argAt(noActive.named("telemetry", "reportMessageSent")[0], 0).agentId, "latest");
    (noActive.deps.rosterBookkeeping as { latestActiveAgentId: string | null }).latestActiveAgentId = null;
    await fallbackApi.sendPrompt({ prompt: "hello" });
    assert.equal(argAt(noActive.named("telemetry", "reportMessageSent")[1], 0).agentId, "unknown");
    // A group agent is reported as a group room, and the env switch holds the answer for the turn.
    const groupWorld = gatewayWorld();
    await groupWorld.api.sendPrompt({ agentId: "group", prompt: "to the group" });
    assert.equal(argAt(groupWorld.named("telemetry", "reportMessageSent")[0], 0).isGroupRoom, true);
    const previous = process.env[DISABLE_SEND_ACCEPT_RETURN_ENV];
    process.env[DISABLE_SEND_ACCEPT_RETURN_ENV] = "1";
    try {
      await groupWorld.api.sendPrompt({ agentId: "group", prompt: "waited" });
    } finally {
      if (previous === undefined) delete process.env[DISABLE_SEND_ACCEPT_RETURN_ENV];
      else process.env[DISABLE_SEND_ACCEPT_RETURN_ENV] = previous;
    }
    assert.equal(argAt(groupWorld.named("transcript", "sendPrompt")[1], 1).awaitTurn, true);
  });

  it("cleans up after a deleted agent, even when the schedules cannot be removed", async () => {
    const world = gatewayWorld();
    await world.api.deleteAgent({ id: "a" });
    assert.deepEqual(world.named("cross-user-sharing", "noteAgentDeleted")[0]?.[2], ["a"]);
    assert.deepEqual(world.named("transcript", "deleteAgent")[0]?.[2], ["a"]);
    assert.deepEqual(world.named("session", "forgetHandoff")[0]?.[2], ["a"]);
    assert.deepEqual(world.named("automations", "deleteAgentSchedules")[0]?.[2], ["a"]);
    assert.deepEqual(world.events.filter((event) => event[0] === "release"), [["release", "a"]]);
    assert.equal((world.events.filter((event) => event[0] === "emit")[0]?.[1] as { kind: string }).kind, "notification-agent-forgotten");
    assert.deepEqual(world.events.filter((event) => event[0] === "forgetPermission"), [["forgetPermission", "a"]]);
    // The whole list is cleaned the same way per id.
    const many = gatewayWorld();
    await many.api.deleteAgents({ ids: ["b", "c"] });
    assert.deepEqual(many.named("session", "forgetHandoff").map((call) => call[2][0]), ["b", "c"]);
    assert.deepEqual(many.events.filter((event) => event[0] === "release"), [["release", "b"], ["release", "c"]]);
    // A schedules removal that fails is swallowed, and the rest of the clean-up still happens.
    const failing = gatewayWorld();
    (failing.registry.automations as Record<string, unknown>).deleteAgentSchedules = async () => { throw new Error("cannot"); };
    await many.api.deleteAgent({ id: "d" });
    await failing.api.deleteAgent({ id: "d" });
    assert.equal(many.events.filter((event) => event[0] === "forgetPermission").length >= 3, true);
  });

  it("reports what automation and broadcast calls produced", async () => {
    const world = gatewayWorld();
    await world.api.createAgentAutomation({ id: "a", spec: { trigger: { type: "cron" } } });
    assert.deepEqual(world.named("telemetry.analytics", "trackEvent")[0]?.[2], ["slate.automation.created", { agent_id: "a", trigger_type: "cron", source: "automations_ui" }]);
    // A workflow with a trigger counts as an automation and is reported; a plain one is not.
    const workflows = gatewayWorld();
    let automations = [{ id: "existing" }];
    (workflows.registry.transcript as Record<string, unknown>).getAgentAutomations = async () => automations;
    (workflows.registry.transcript as Record<string, unknown>).createAgentWorkflow = async () => { automations = [...automations, { id: "w" }]; return automations; };
    await workflows.api.createAgentWorkflow({ id: "a", spec: { trigger: { kind: "cron" } } });
    assert.deepEqual(workflows.named("telemetry.analytics", "trackEvent")[0]?.[2], ["slate.automation.created", { agent_id: "a", trigger_type: "cron", source: "workflow_ui" }]);
    await workflows.api.createAgentWorkflow({ id: "a", spec: { steps: [] } });
    assert.equal(workflows.named("telemetry.analytics", "trackEvent").length, 1);
    assert.deepEqual(await workflows.api.broadcastToAgents({ targets: "all", message: "hello" }), { total: 2, scheduled: 2 });
    assert.deepEqual(workflows.named("telemetry.analytics", "trackEvent")[1]?.[2], ["slate.broadcast.sent", { total: 2, scheduled: 2, targets: "all" }]);
    await workflows.api.broadcastToAgents({ targets: ["a"], message: "hi" });
    assert.equal(argAt(workflows.named("telemetry.analytics", "trackEvent")[2], 1).targets, "subset");
  });

  it("gates searches on the content search being enabled", async () => {
    const world = gatewayWorld();
    assert.deepEqual(await world.api.searchAgents({ query: "q", limit: 2 }), [{ id: "found" }]);
    assert.deepEqual(await world.api.searchMedia({ query: "q" }), [{ id: "media" }]);
    const off = gatewayWorld();
    off.registry["content-search"] = { isEnabled: () => false };
    const offApi = createHostGatewayApi(off.deps as never) as any;
    assert.deepEqual(await offApi.searchAgents({ query: "q" }), []);
    assert.deepEqual(await offApi.searchMedia({ query: "q" }), []);
    assert.equal(off.named("transcript", "searchAgents").length, 0);
  });

  it("answers the host's status, box migration and recreate lifecycle in order", async () => {
    const world = gatewayWorld();
    assert.deepEqual(await world.api.getHostStatus(), { version: "1.0.0", isBusy: true, capabilities: [...HOST_CAPABILITIES] });
    assert.deepEqual(await world.api.setBoxMigrating({ migrating: true }), { ok: true });
    assert.deepEqual(world.named("forever-box", "setMigrating")[0]?.[2], [{ migrating: true }]);
    await world.api.setBoxMigrating({});
    assert.deepEqual(world.named("forever-box", "setMigrating")[1]?.[2], [{ migrating: false }]);
    await world.api.prepareBoxForRecreate();
    const prepareCalls = world.calls.slice(world.calls.findIndex((call) => call[1] === "suspendWakes"));
    assert.deepEqual(prepareCalls.slice(0, 2).map((call) => [call[0], call[1]]), [["automations", "suspendWakes"], ["transcript", "quiesceForRecreate"]]);
    await world.api.resumeBoxAfterRecreate({ agentIds: ["a"], pendingWakes: [] });
    const resumeCalls = world.calls.slice(world.calls.findIndex((call) => call[1] === "resumeWakes"));
    assert.deepEqual(resumeCalls.slice(0, 3).map((call) => [call[0], call[1]]), [["automations", "resumeWakes"], ["cross-user-sharing", "resumeAfterRecreate"], ["transcript", "resumeAfterRecreate"]]);
    // Handing the box back names the trigger, defaulting to the button.
    await world.api.handBackForeverBox({ id: "a" });
    assert.deepEqual(world.named("session", "endHandoff")[0]?.[2], ["a", "button"]);
    await world.api.handBackForeverBox({ id: "a", trigger: "upgrade" });
    assert.deepEqual(world.named("session", "endHandoff")[1]?.[2], ["a", "upgrade"]);
  });

  it("sets host settings and notes the changes they imply", async () => {
    const world = gatewayWorld();
    await world.api.setHostSettings({ localToolPermission: "ask", webauthnProxyEnabled: true });
    assert.deepEqual(world.named("local-tool-permission", "notePermissionChanged").length, 1);
    assert.deepEqual(world.named("webauthn-proxy", "applyEnablement")[0]?.[2], [true]);
    await world.api.setHostSettings({});
    assert.equal(world.named("local-tool-permission", "notePermissionChanged").length, 1);
    assert.equal(world.named("webauthn-proxy", "applyEnablement").length, 1);
  });

  it("routes mcp refreshes, tools and box servers", async () => {
    const world = gatewayWorld();
    const tools = await world.api.listRoutedMcpTools();
    assert.deepEqual(tools, [
      { name: "tool", providerIdentifier: "p", toolName: "read", description: "described", inputSchema: { schema: 1 } },
      { name: "second", providerIdentifier: "p", toolName: "write" },
    ]);
    assert.deepEqual(await world.api.executeRoutedMcpTool({ agentId: "a", name: "request-name", toolName: "wired-name", providerIdentifier: "p", args: { x: 1 }, toolCallId: "call" }), { result: "executed" });
    assert.deepEqual(argAt(world.named("mcp-executor", "execute")[0], 1), { name: "wired-name", toolName: "request-name", providerIdentifier: "p", args: { x: 1 }, toolCallId: "call" });
    assert.deepEqual(await world.api.refreshMcp({ routedAction: "list-tools" }), tools);
    await world.api.refreshMcp({ completion: { code: "c" } });
    assert.deepEqual(world.events.filter((event) => event[0] === "auth"), [["auth", { code: "c" }]]);
    await world.api.refreshMcp({});
    assert.equal(world.named("mcp.management", "restart").length, 1);
    assert.deepEqual(await world.api.listBoxMcpServers({ serverIdentifiers: ["withdetail", "plain"] }), {
      servers: [
        { serverIdentifier: "withdetail", status: "ok", statusDetail: "detail", toolCount: 2 },
        { serverIdentifier: "plain", status: "ok", toolCount: 2 },
      ],
    });
  });

  it("refuses malformed transcript requests and passes the parsed ones on", async () => {
    const world = gatewayWorld();
    assert.throws(() => world.api.getAgentTranscriptWindow({}), /Malformed getAgentTranscriptWindow request/);
    assert.throws(() => world.api.getAgentThread({}), /Malformed getAgentThread request/);
    assert.deepEqual(await world.api.getAgentTranscript({ id: "a" }), { entries: [] });
    assert.deepEqual(await world.api.getAgentTranscriptPage({ id: "a" }), { entries: [] });
    assert.deepEqual(await world.api.getAgentTranscriptTail({ id: "a" }), { entries: [] });
    assert.deepEqual(await world.api.getTranscript(), { entries: [] });
  });

  it("decodes an avatar or clears it, and decorates the box status", async () => {
    const world = gatewayWorld();
    await world.api.setAgentAvatarBytes({ id: "a", pngBase64: Buffer.from("png").toString("base64") });
    assert.deepEqual(world.named("transcript", "setAgentAvatarBytes")[0]?.[2], ["a", new Uint8Array(Buffer.from("png"))]);
    await world.api.setAgentAvatarBytes({ id: "a", pngBase64: null });
    assert.deepEqual(world.named("transcript", "setAgentAvatarBytes")[1]?.[2], ["a", null]);
    assert.deepEqual(await world.api.getForeverBoxStatus({ id: "a" }), { state: "present", decorated: true });
    assert.deepEqual(await world.api.ensureForeverBox({ id: "a" }), { state: "present", decorated: true });
    assert.deepEqual(await world.api.resetForeverBox({ id: "a" }), { state: "absent", decorated: true });
    assert.deepEqual(await world.api.updateForeverBox({ id: "a" }), { state: "present", decorated: true });
  });

  it("refuses a call whose extension has no method, and keeps the receiver", async () => {
    const missing = gatewayWorld();
    missing.registry["teach-recording"] = {};
    const missingApi = createHostGatewayApi(missing.deps as never) as any;
    assert.throws(() => missingApi.getTeachRecordingStatus(), /host extension method is unavailable: getStatus/);
    // The method is called with its extension as the receiver, not detached from it.
    const receiver = gatewayWorld();
    receiver.registry["teach-recording"] = { marker: "owned", getStatus(this: { marker: string }) { return this.marker; } };
    const boundApi = createHostGatewayApi(receiver.deps as never) as any;
    assert.equal(boundApi.getTeachRecordingStatus(), "owned");
  });

  it("answers the calls that have nothing to do", async () => {
    const world = gatewayWorld();
    assert.equal(await world.api.completeMcpOAuth(), undefined);
    assert.equal(await world.api.setAgentNotificationsEnabled(), undefined);
    assert.equal(await world.api.isEgressTunnelAvailable(), false);
    assert.deepEqual(await world.api.getTrays(), []);
  });
});
