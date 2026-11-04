/**
 * The host's runtime pieces, tenth group: how the sharing service and the local-exec bridge are wired into the
 * host, the codec this build uses for the bridge, the wakes a restart still owes, and the guard that asks the
 * user before their routines keep spending while they are away.
 */

import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";

import { mcpExecutorResource } from "../../source/packages/agent-exec/mcp-operations.ts";
import { createContext } from "../../source/packages/context/context.ts";
import { ExecClientMessage } from "../../source/adapters/interop/proto/generated/agent/v1/exec_pb.ts";
import { HostExtensions } from "../../source/host/extensions/extension-ids.generated.ts";
import { createLocalExecExtension } from "../../source/host/local-exec/extension.ts";
import { createBridgeUserComputers, GatewayLocalExecBox, type GatewayExecControl, type GatewayLocalExecCodec, type GatewayLocalExecManager } from "../../source/host/local-exec/gateway-local-exec-slate-box.ts";
import { SlateLocalExecBridge, type LocalExecBridgeFrame } from "../../source/host/local-exec/local-exec-bridge.ts";
import { productionLocalExecCodec } from "../../source/adapters/interop/agent/local-exec-codec-adapter.ts";
import { createCrossUserSharingExtension, crossUserSharingExtension, SHARING_DISABLED_MESSAGE } from "../../source/host/rooms/extension.ts";
import { evaluateAutomationSpendGuard, interpretSpendGuardAnswer, isSpendGuardCard, SPEND_GUARD_ANSWER_VALUES, SPEND_GUARD_IDLE_TTL_MS, SPEND_GUARD_MIN_FIRES_SINCE_VIEWED, SPEND_GUARD_MIN_UNREAD_COUNT, SPEND_GUARD_PAUSE_DELAY_MS, SPEND_GUARD_SNOOZE_MS, SPEND_GUARD_VALUE_PREFIX, countAutomationRunsSince, buildSpendGuardNudgeWidget, buildSpendGuardPausedWidget, renderSpendGuardAnswerAck, renderSpendGuardNudgeReminder } from "../../source/host/transcript/slate-automation-spend-guard.ts";
import { coerceMarker, coercePendingWakeMarkers, coerceQuietOrigin, markerKeyMatches, PENDING_WAKE_KINDS, parsePendingWakeFile, SlatePendingWakeStore, upsertPendingWakeMarker } from "../../source/host/transcript/slate-pending-wake-store.ts";
import { EMPTY_SLATE_SHARING_STATE } from "../../source/shared/agents/sharing.ts";

/** A turn of the event loop, which is what a poll that was started and not awaited needs. */
const settle = (): Promise<void> => new Promise((resolve) => { setTimeout(resolve, 0); });

/** What the sharing extension hands the host, as this test drives it. */
interface SharingApi {
  readonly isEnabled: boolean;
  getSharingState(): Promise<{ selfAuthId: string | null }>;
  createRoomFromAgent(args: { agentId: string }): Promise<unknown>;
  createRoomInvite(args: { roomId: string }): Promise<unknown>;
  joinSharedRoom(args: { link: string }): Promise<unknown>;
  respondToRoomJoinRequest(args: { requestId: string }): Promise<unknown>;
  createSharedRoom(args: { agents: Array<Record<string, unknown>> }): Promise<unknown>;
  addOwnAgentToSharedRoom(args: { agentId: string }): Promise<unknown>;
  removeOwnAgentFromSharedRoom(args: { roomId: string; agentId: string }): Promise<unknown>;
  setSharedRoomTyping(args: { roomId: string; isTyping: boolean }): Promise<void>;
  leaveSharedRoom(args: { roomId: string; targetAuthId?: string }): Promise<unknown>;
  noteAgentDeleted(agentId: string): Promise<void>;
  subscribe(listener: (state: unknown) => void): () => void;
  prepareForUpgrade(): void;
}

describe("sharing wired into the host", () => {
  const account = "header.eyJzdWIiOiJzZWxmLTkifQ.sig"; // { sub: "self-9" }

  async function startSharing(options: { gate?: boolean; allowed?: boolean; notifications?: boolean } = {}) {
    const remembered = { SLATE_DEV_XUSER_SHARING: process.env.SLATE_DEV_XUSER_SHARING, SLATE_BACKEND_URL: process.env.SLATE_BACKEND_URL };
    process.env.SLATE_BACKEND_URL = "https://backend.test.invalid";
    if (options.allowed === false) delete process.env.SLATE_DEV_XUSER_SHARING;
    else process.env.SLATE_DEV_XUSER_SHARING = "1";
    const originalFetch = globalThis.fetch;
    const originalWarn = console.warn;
    const calls: Array<{ path: string; body: unknown }> = [];
    const origins: string[] = [];
    const gateNames: string[] = [];
    const warns: string[] = [];
    const logs: string[] = [];
    const stops: Array<() => void> = [];
    const delegates: Array<[string, unknown]> = [];
    const published: unknown[] = [];
    const topics = new Map<string, () => void>();
    const notices = new Map<string, (value: boolean) => void>();
    globalThis.fetch = (async (input: string | URL | Request) => {
      const url = new URL(String(input));
      calls.push({ path: url.pathname, body: undefined });
      origins.push(url.origin);
      return new Response(JSON.stringify({ pendingJoinRequests: [], rooms: [] }), { status: 200 });
    }) as typeof fetch;
    console.warn = (...args: unknown[]) => { warns.push(args.join(" ")); };
    const manager = new Proxy({}, { get: (_target, name) => (...args: unknown[]) => { delegates.push([String(name), args[0]]); return null; } });
    const gateValue = { current: options.gate ?? false };
    let notify: ((value: boolean) => void) | undefined;
    const api = await createCrossUserSharingExtension().start({
      deps: {
        [HostExtensions.Auth]: { getAccessToken: async () => account },
        [HostExtensions.Transcript]: manager,
        [HostExtensions.Attachments]: { resolveChannelAttachment: async () => null },
        [HostExtensions.NotifyBus]: {
          isConnected: () => true,
          isSafetyPollEnabled: () => true,
          onNotify: (topic: string, callback: () => void) => { topics.set(topic, callback); return () => topics.delete(topic); },
        },
        [HostExtensions.Experiments]: { getFeatureGateProperty: (name: string) => { gateNames.push(name); return (notices.set(name, () => {}), { get: () => gateValue.current, subscribe: (listener: (value: boolean) => void) => { const previous = notices.get(name); notices.set(name, (value: boolean) => { previous?.(value); listener(value); }); return () => {}; } }); } },
      },
      host: { log: (message: string) => { logs.push(message); }, whenBackgroundWorkReady: Promise.resolve() },
      onStop: (teardown: () => void) => { stops.push(teardown); },
    }) as SharingApi;
    await settle();
    return {
      api,
      calls,
      origins,
      gateNames,
      warns,
      logs,
      stops,
      delegates,
      published,
      topics,
      notices,
      setGate(on: boolean) { gateValue.current = on; for (const notice of notices.values()) notice(on); },
      restore() {
        globalThis.fetch = originalFetch;
        console.warn = originalWarn;
        for (const [key, value] of Object.entries(remembered)) if (value === undefined) delete process.env[key]; else process.env[key] = value;
      },
    };
  }

  it("registers under its own id with the modules it needs, and off is off", async () => {
    assert.equal(crossUserSharingExtension.kind, "host-extension");
    assert.equal(crossUserSharingExtension.id, HostExtensions.CrossUserSharing);
    assert.deepEqual(crossUserSharingExtension.dependencies, ["attachments", "auth", "experiments", "transcript", "notify-bus"]);
    assert.equal(SHARING_DISABLED_MESSAGE, "Sharing isn't enabled for your account.");

    const host = await startSharing({ gate: false });
    assert.equal(host.api.isEnabled, false);
    assert.deepEqual(await host.api.getSharingState(), EMPTY_SLATE_SHARING_STATE);
    assert.deepEqual(await host.api.createRoomFromAgent({ agentId: "agent-1" }), { status: "error", message: SHARING_DISABLED_MESSAGE });
    assert.deepEqual(await host.api.createRoomInvite({ roomId: "room-1" }), { status: "error", message: SHARING_DISABLED_MESSAGE });
    assert.deepEqual(await host.api.joinSharedRoom({ link: "https://example.invalid/s/1" }), { status: "error", message: SHARING_DISABLED_MESSAGE });
    assert.deepEqual(await host.api.createSharedRoom({ agents: [] }), { status: "error", message: SHARING_DISABLED_MESSAGE });
    assert.deepEqual(await host.api.respondToRoomJoinRequest({ requestId: "ask-1" }), EMPTY_SLATE_SHARING_STATE);
    assert.deepEqual(await host.api.leaveSharedRoom({ roomId: "room-1" }), EMPTY_SLATE_SHARING_STATE);
    assert.equal(await host.api.setSharedRoomTyping({ roomId: "room-1", isTyping: true }), undefined);
    assert.equal(await host.api.noteAgentDeleted("agent-1"), undefined);
    assert.equal(host.calls.length, 0);
    // A caller can watch the state and stop watching, and every teardown is registered with the host.
    const seen: unknown[] = [];
    const unwatch = host.api.subscribe((state) => { seen.push(state); });
    assert.equal(typeof unwatch, "function");
    assert.equal(typeof host.api.prepareForUpgrade, "function");
    host.api.prepareForUpgrade();
    host.api.prepareForUpgrade();
    assert.equal(host.stops.length, 3);
    // Turning it off also withdraws the delegate it would have published through.
    assert.deepEqual(host.delegates, [["setXuserDelegate", null]]);
    for (const stop of host.stops) stop();
    assert.equal(host.topics.size, 0);
    host.restore();
  });

  it("turns sharing on with the platform's switch, reads the account in, and turns it off again", async () => {
    const host = await startSharing({ gate: false });
    assert.equal(host.api.isEnabled, false);
    host.setGate(true);
    await settle();
    assert.equal(host.api.isEnabled, true);
    assert.deepEqual(host.gateNames, ["slate_multiplayer"]);
    assert.deepEqual([...new Set(host.origins)], ["https://backend.test.invalid"]);
    // The transcript is handed the delegate that publishes what the host has to say into a room.
    assert.deepEqual([...new Set(host.delegates.map(([name]) => name))], ["setXuserDelegate"]);
    assert.equal(typeof host.delegates[0]?.[1], "object");
    assert.deepEqual(host.calls.map((call) => call.path), ["/slate/share-state", "/slate/xuser/poll"]);
    // The account the host is signed in as comes from its own token, not from a second request.
    assert.equal((await host.api.getSharingState()).selfAuthId, "self-9");
    await host.api.setSharedRoomTyping({ roomId: "room-1", isTyping: true });
    assert.equal(host.calls.at(-1)?.path, "/slate/xuser/send");

    // A notification is heard: the listener is registered, and firing it does not poll again before the
    // drain floor has passed since the last poll (which is what keeps a burst of notifications to one drain).
    const before = host.calls.length;
    assert.equal(host.topics.has("xuser-events"), true);
    host.topics.get("xuser-events")?.();
    await settle();
    assert.equal(host.calls.length, before);

    // Turning the switch off stops the service and hands every watcher the state that says so.
    const seen: unknown[] = [];
    host.api.subscribe((state) => { seen.push(state); });
    host.setGate(false);
    assert.equal(host.api.isEnabled, false);
    assert.deepEqual(seen.at(-1), EMPTY_SLATE_SHARING_STATE);
    assert.equal(host.delegates.at(-1)?.[1], null);
    for (const stop of host.stops) stop();
    host.restore();
  });

  it("keeps sharing off where the platform does not allow it, and says why", async () => {
    const host = await startSharing({ gate: true, allowed: false });
    assert.equal(host.api.isEnabled, false);
    assert.equal(host.calls.length, 0);
    assert.equal(host.warns.length, 1);
    assert.equal(host.warns[0]?.startsWith("[slate:sharing] Sharing another user's computer is disabled on developer builds."), true);
    assert.equal(host.warns[0]?.includes("second box under this account"), true);
    assert.equal(host.warns[0]?.includes("SLATE_DEV_XUSER_SHARING=1"), true);
    for (const stop of host.stops) stop();
    host.restore();
  });
});

/** What the local-exec extension hands the host, as this test drives it. */
type LocalExecClient = { readonly frame: unknown };
interface LocalExecApi {
  readonly box: GatewayLocalExecBox<LocalExecClient, GatewayLocalExecManager<LocalExecClient>>;
  readonly userComputers: ReturnType<typeof createBridgeUserComputers<LocalExecClient, GatewayLocalExecManager<LocalExecClient>>>;
  registerProvider(send: (frame: LocalExecBridgeFrame) => void): () => void;
  submitResponses(batch: Parameters<SlateLocalExecBridge["submitResponses"]>[0]): void;
  checkLiveComputerForAsk(agentId?: string): boolean;
}

describe("the local-exec bridge wired into the host", () => {
  function startLocalExec() {
    const refusals: Array<Record<string, unknown>> = [];
    const providers: Array<Record<string, unknown>> = [];
    const failures: unknown[] = [];
    const topics = new Map<string, (payload: unknown) => void>();
    const stops: Array<() => void> = [];
    const sent: Array<Record<string, unknown>> = [];
    const approvals: Array<{ action: string; target: string }> = [];
    const codec: GatewayLocalExecCodec<LocalExecClient, GatewayLocalExecManager<LocalExecClient>> = {
      decodeClient: (json) => json as LocalExecClient,
      decodeControl: (json) => json as GatewayExecControl,
      createRemoteAccessor: (manager) => manager,
    };
    const extension = createLocalExecExtension(codec);
    const gate = { blockedReason: () => undefined, requiresApproval: () => true, authorize: async (_scope: unknown, request: { action: string; target: string }) => { approvals.push(request); return { allowed: true, reason: "", approvalId: "approval-1" }; } };
    const telemetry = { logs: { reportLocalExecRefused: (report: Record<string, unknown>) => { refusals.push(report); }, reportLocalExecProvider: (report: Record<string, unknown>) => { providers.push(report); }, reportLocalExecFailed: (report: unknown) => { failures.push(report); } } };
    return Promise.resolve(extension.start({
      deps: { [HostExtensions.LocalToolPermission]: gate, [HostExtensions.Telemetry]: telemetry },
      host: { events: { on(topic: string, listener: (payload: unknown) => void) { topics.set(topic, listener); return () => topics.delete(topic); } } },
      onStop: (teardown: () => void) => { stops.push(teardown); },
    })).then((started) => ({ api: started as LocalExecApi, refusals, providers, failures, topics, stops, sent, approvals, extension, detach: (started as LocalExecApi).registerProvider((frame: LocalExecBridgeFrame) => { sent.push(frame); }) }));
  }

  it("registers under its own id with what it depends on, and hands the host the bridge's surface", async () => {
    const host = await startLocalExec();
    assert.equal(host.extension.id, HostExtensions.LocalExec);
    assert.deepEqual(host.extension.dependencies, [HostExtensions.LocalToolPermission, HostExtensions.Telemetry]);
    assert.deepEqual(Object.keys(host.api), ["box", "userComputers", "registerProvider", "submitResponses", "checkLiveComputerForAsk"]);
    assert.equal(host.stops.length, 1);
    // A daemon that has connected but not yet said which machine it is stands in as this one.
    assert.deepEqual(host.api.userComputers.list(), [{ id: "this-computer", label: "this computer", connected: true }]);
    assert.equal(host.api.userComputers.resolve()?.id, "this-computer");
    assert.equal(await host.api.box.runState(createContext(), "agent-1"), "running");
    // With no daemon connected at all, a call that needs the machine reports a refusal rather than waiting.
    host.detach();
    assert.equal(host.api.checkLiveComputerForAsk(), false);
    assert.equal(host.api.checkLiveComputerForAsk("agent-1"), false);
    assert.deepEqual(host.refusals.map((report) => [report.cause, report.site]), [["no_providers", "ask_gate"], ["no_providers", "ask_gate"]]);
    assert.equal(await host.api.box.runState(createContext(), "agent-1"), "absent");
    assert.deepEqual(host.api.userComputers.list(), []);
    assert.equal(host.api.userComputers.resolve(), undefined);
  });

  it("takes the machine's hello, reports it, and takes a retired approval back", async () => {
    const host = await startLocalExec();
    host.api.submitResponses({ frames: [{ kind: "hello", localRoot: "/home/user", terminalsFolder: "/home/user/terminals", computerId: "computer-1", label: "Laptop" }] });
    assert.equal(host.api.checkLiveComputerForAsk("agent-1"), true);
    assert.deepEqual(host.providers.map((report) => report.phase), ["registered", "hello"]);
    assert.deepEqual(host.api.userComputers.list(), [{ id: "computer-1", label: "Laptop", connected: true }]);
    assert.equal(host.api.userComputers.resolve()?.id, "computer-1");
    assert.equal(host.api.userComputers.resolve()?.box.terminalsFolder(), "/home/user/terminals");
    assert.equal(await host.api.box.runState(createContext(), "agent-1"), "running");
    // An approval the user retired is taken back from the machine; a payload without one is ignored.
    host.topics.get("local-tool-permission.approval-retired")?.({ approvalId: "approval-9" });
    assert.deepEqual({ kind: host.sent.at(-1)?.kind, approvalId: host.sent.at(-1)?.approvalId }, { kind: "retire-approval", approvalId: "approval-9" });
    host.topics.get("local-tool-permission.approval-retired")?.({ approvalId: 7 });
    assert.equal(host.sent.filter((frame) => frame.kind === "retire-approval").length, 1);
    host.detach();
    assert.equal(host.api.checkLiveComputerForAsk(), false);
    assert.equal(host.refusals.at(-1)?.cause, "no_providers");
    for (const stop of host.stops) stop();
    assert.equal(host.topics.size, 0);
  });

  it("decodes what the machine sends and stands the resource accessor over the manager", () => {
    assert.equal(Object.isFrozen(productionLocalExecCodec), true);
    const client = productionLocalExecCodec.decodeClient({ execId: "exec-1", somethingElse: 1 });
    assert.equal(client instanceof ExecClientMessage, true);
    assert.equal(client.execId, "exec-1");
    assert.deepEqual(productionLocalExecCodec.decodeControl({ throw: { error: "boom", stackTrace: "at sh" } }), { case: "throw", error: "boom", stackTrace: "at sh" });
    // A throw without a stack is a throw: the field is left out rather than being sent as an empty one.
    assert.deepEqual(productionLocalExecCodec.decodeControl({ throw: { error: "boom" } }), { case: "throw", error: "boom" });
    assert.deepEqual(productionLocalExecCodec.decodeControl({ stream_close: {} }), { case: "streamClose" });
    // A control the bridge does not act on is not one, whether it is unrecognized or empty.
    assert.deepEqual(productionLocalExecCodec.decodeControl({ heartbeat: {} }), { case: undefined });
    assert.deepEqual(productionLocalExecCodec.decodeControl({}), { case: undefined });
    const accessor = productionLocalExecCodec.createRemoteAccessor("the manager" as never);
    assert.equal(typeof accessor.get, "function");
    // The accessor builds each operation's client over the manager it was given, with no message of its own.
    const resource = mcpExecutorResource as unknown as Parameters<typeof accessor.get>[0];
    const implementation = accessor.get(resource) as { execute?: unknown };
    assert.equal(typeof implementation.execute, "function");
  });
});

describe("the wakes a restart still owes", () => {
  const root = () => mkdtempSync(join(tmpdir(), "slate-wake-"));

  it("writes a wake down, replaces the same one, and forgets what was delivered or grew too old", () => {
    const store = new SlatePendingWakeStore(root());
    assert.deepEqual(PENDING_WAKE_KINDS, ["cloud-agent", "subagent", "shell"]);
    assert.equal(store.filePath.endsWith("host-pending-wakes.json"), true);
    assert.deepEqual(store.listPending(), []);
    assert.equal(store.hasPending("agent-1", "shell", "work-1"), false);
    assert.equal(store.markPending({ agentId: "agent-1", kind: "shell", workId: "work-1", markedAtMs: 1_000 }), true);
    assert.equal(store.hasPending("agent-1", "shell", "work-1"), true);
    assert.deepEqual(JSON.parse(readFileSync(store.filePath, "utf8")), { version: 1, pending: [{ agentId: "agent-1", kind: "shell", workId: "work-1", markedAtMs: 1_000 }] });
    // The same wake marked again is one wake, and a different kind of work on the same work id is another.
    assert.equal(store.markPending({ agentId: "agent-1", kind: "shell", workId: "work-1", markedAtMs: 1_500 }), true);
    store.markPending({ agentId: "agent-1", kind: "subagent", workId: "work-1", markedAtMs: 2_000, title: "task", subagentType: "executor", quietOrigin: { automation: { id: "automation-1", name: "Nightly" } }, interruptedByRecreate: true });
    assert.deepEqual(store.listPending().map((marker) => [marker.kind, marker.markedAtMs]), [["shell", 1_500], ["subagent", 2_000]]);
    assert.equal(store.hasPending("agent-1", "cloud-agent", "work-1"), false);

    const delivered = new SlatePendingWakeStore(root());
    delivered.markPending({ agentId: "agent-1", kind: "shell", workId: "work-1", markedAtMs: 1_000 });
    delivered.markPending({ agentId: "agent-1", kind: "subagent", workId: "work-2", markedAtMs: 2_000 });
    // A wake that was not marked is not delivered, and clearing it does not touch the other.
    assert.equal(delivered.clearOne("agent-1", "shell", "work-9"), false);
    assert.equal(delivered.clearOne("agent-1", "shell", "work-1"), true);
    assert.deepEqual(delivered.listPending().map((marker) => marker.workId), ["work-2"]);
    // The one that grew too old is handed back and dropped, and the file goes with the last of them.
    assert.deepEqual(delivered.pruneStale(500, 2_600).map((marker) => marker.workId), ["work-2"]);
    assert.equal(existsSync(delivered.filePath), false);
    assert.deepEqual(delivered.listPending(), []);

    const cleared = new SlatePendingWakeStore(root());
    cleared.markPending({ agentId: "agent-1", kind: "shell", workId: "work-1", markedAtMs: 1_000 });
    cleared.markPending({ agentId: "agent-2", kind: "shell", workId: "work-2", markedAtMs: 1_000 });
    cleared.clearAgent("agent-2");
    assert.deepEqual(cleared.listPending().map((marker) => marker.agentId), ["agent-1"]);
    cleared.clearAll();
    assert.equal(existsSync(cleared.filePath), false);
  });

  it("reads a wake back into shape, and refuses anything that is not one", () => {
    assert.deepEqual(coerceMarker({ agentId: "agent-1", kind: "subagent", workId: "work-1" }), { agentId: "agent-1", kind: "subagent", workId: "work-1", markedAtMs: 0 });
    // A marker without an agent, a work id or a kind the platform knows is not a marker at all.
    assert.equal(coerceMarker({ agentId: "", kind: "shell", workId: "work-1" }), null);
    assert.equal(coerceMarker({ agentId: "agent-1", kind: "shell" }), null);
    assert.equal(coerceMarker({ agentId: "agent-1", kind: "something-else", workId: "work-1" }), null);
    assert.equal(coerceMarker(7), null);
    assert.equal(coerceQuietOrigin(null), null);
    assert.deepEqual(coerceQuietOrigin({ automation: { id: "automation-1", name: "Nightly" } }), { automation: { id: "automation-1", name: "Nightly" } });
    // An origin that names no automation is still an origin, and one without a name is not.
    assert.deepEqual(coerceQuietOrigin({ automation: null }), {});
    assert.deepEqual(coerceQuietOrigin({ automation: { id: "", name: "Nightly" } }), {});
    // What is empty is left out, and the flag is only there when it is true.
    assert.deepEqual(parsePendingWakeFile(JSON.stringify({ pending: [{ agentId: "agent-1", kind: "shell", workId: "work-1", markedAtMs: 5, title: "", subagentType: "", quietOrigin: {}, interruptedByRecreate: false }] })), [{ agentId: "agent-1", kind: "shell", workId: "work-1", markedAtMs: 5, quietOrigin: {} }]);
    assert.deepEqual(coercePendingWakeMarkers("nope"), []);
    assert.deepEqual(parsePendingWakeFile("{not json"), []);
    assert.deepEqual(parsePendingWakeFile(null), []);
    const existing = [{ agentId: "agent-1", kind: "shell" as const, workId: "work-1", markedAtMs: 1 }, { agentId: "agent-1", kind: "shell" as const, workId: "work-2", markedAtMs: 2 }];
    assert.deepEqual(upsertPendingWakeMarker(existing, { agentId: "agent-1", kind: "shell", workId: "work-1", markedAtMs: 9 }).map((marker) => marker.markedAtMs), [2, 9]);
    assert.equal(markerKeyMatches({ agentId: "agent-1", kind: "shell", workId: "work-1", markedAtMs: 1 }, "agent-1", "shell", "work-1"), true);
    assert.equal(markerKeyMatches({ agentId: "agent-1", kind: "shell", workId: "work-1", markedAtMs: 1 }, "agent-1", "subagent", "work-1"), false);
    const directory = root();
    const store = new SlatePendingWakeStore(directory);
    writeFileSync(store.filePath, JSON.stringify({ pending: "nope" }));
    assert.deepEqual(new SlatePendingWakeStore(directory).listPending(), []);
  });
});

describe("the guard that asks before routines keep spending", () => {
  const away = { lastViewedAtMs: 0, unreadCount: 0, firesSinceViewedCount: 0, nudgedAtMs: null, snoozedUntilMs: null, optedOut: false };
  const now = SPEND_GUARD_IDLE_TTL_MS + 1_000;

  it("bounds how long away is away, and what counts as nobody reading", () => {
    assert.equal(SPEND_GUARD_IDLE_TTL_MS, 3 * 24 * 60 * 60_000);
    assert.equal(SPEND_GUARD_PAUSE_DELAY_MS, 3 * 24 * 60 * 60_000);
    assert.equal(SPEND_GUARD_SNOOZE_MS, 30 * 24 * 60 * 60_000);
    assert.equal(SPEND_GUARD_MIN_UNREAD_COUNT, 15);
    assert.equal(SPEND_GUARD_MIN_FIRES_SINCE_VIEWED, 20);
    assert.equal(SPEND_GUARD_VALUE_PREFIX, "spend-guard:");
  });

  it("takes the answer that was already given first, and only then what the numbers say", () => {
    assert.equal(evaluateAutomationSpendGuard({ ...away, nowMs: now, optedOut: true }), "opted-out");
    // A user who was here recently is left alone whatever the counts say.
    assert.equal(evaluateAutomationSpendGuard({ ...away, nowMs: now, lastViewedAtMs: now - 1_000, unreadCount: 99 }), "user-active");
    assert.equal(evaluateAutomationSpendGuard({ ...away, nowMs: now, snoozedUntilMs: now + 1_000 }), "snoozed");
    assert.equal(evaluateAutomationSpendGuard({ ...away, nowMs: now, snoozedUntilMs: now - 1_000 }), "below-thresholds");
    // Once asked, the question is not asked again: it is either still waiting for an answer or it becomes a pause.
    assert.equal(evaluateAutomationSpendGuard({ ...away, nowMs: now, nudgedAtMs: now - 1_000 }), "awaiting-ack");
    assert.equal(evaluateAutomationSpendGuard({ ...away, nowMs: now, nudgedAtMs: now - SPEND_GUARD_PAUSE_DELAY_MS }), "pause");
    // An answer from a later visit, and a nudge from before it, do not count as an unanswered question.
    assert.equal(evaluateAutomationSpendGuard({ ...away, nowMs: now, nudgedAtMs: now - 10 * 24 * 60 * 60_000, lastViewedAtMs: now - SPEND_GUARD_IDLE_TTL_MS - 1_000 }), "below-thresholds");
    assert.equal(evaluateAutomationSpendGuard({ ...away, nowMs: now, unreadCount: SPEND_GUARD_MIN_UNREAD_COUNT }), "nudge");
    assert.equal(evaluateAutomationSpendGuard({ ...away, nowMs: now, firesSinceViewedCount: SPEND_GUARD_MIN_FIRES_SINCE_VIEWED }), "nudge");
    assert.equal(evaluateAutomationSpendGuard({ ...away, nowMs: now, unreadCount: SPEND_GUARD_MIN_UNREAD_COUNT - 1, firesSinceViewedCount: SPEND_GUARD_MIN_FIRES_SINCE_VIEWED - 1 }), "below-thresholds");
  });

  it("counts the routines that ran since the user was last here", () => {
    assert.equal(countAutomationRunsSince([{ runs: [{ startedAt: 1 }, { startedAt: 5 }] }, { runs: [{ startedAt: 9 }] }], 4), 2);
    assert.equal(countAutomationRunsSince([], 0), 0);
  });

  it("asks the question with the answers it can act on, and reads one back", () => {
    const nudge = buildSpendGuardNudgeWidget();
    assert.deepEqual(nudge.options.map((option) => option.value), [SPEND_GUARD_ANSWER_VALUES.keep, SPEND_GUARD_ANSWER_VALUES.pause, SPEND_GUARD_ANSWER_VALUES.optOut]);
    assert.equal(nudge.options[0]?.style, "primary");
    assert.deepEqual(buildSpendGuardPausedWidget().options.map((option) => option.value), [SPEND_GUARD_ANSWER_VALUES.resume, SPEND_GUARD_ANSWER_VALUES.stayPaused]);
    assert.equal(interpretSpendGuardAnswer("spend-guard:never-ask"), "optOut");
    assert.equal(interpretSpendGuardAnswer("spend-guard:stay-paused"), "stayPaused");
    assert.equal(interpretSpendGuardAnswer("keep"), null);
    // The platform acts on the answer itself, so the card is only one of its own with one of its own answers.
    assert.equal(isSpendGuardCard(nudge, SPEND_GUARD_ANSWER_VALUES.keep), true);
    assert.equal(isSpendGuardCard(nudge, "something-else"), false);
    assert.equal(isSpendGuardCard({ prompt: "another card", options: [{ label: "Keep", value: SPEND_GUARD_ANSWER_VALUES.keep }] }, SPEND_GUARD_ANSWER_VALUES.keep), false);
  });

  it("tells the agent what the user chose in one line, without asking again", () => {
    const ack = renderSpendGuardAnswerAck("keep");
    assert.equal(ack.split("\n").length, 4);
    assert.equal(ack.includes("keep your routines running, and not to be asked again for a month"), true);
    assert.equal(ack.includes("ALREADY applied that itself"), true);
    assert.equal(ack.includes("Do NOT edit any automation.json"), true);

    const reminder = renderSpendGuardNudgeReminder({ nowMs: now, lastViewedAtMs: 0, unreadCount: 3, firesSinceViewedCount: 4, timeZone: "UTC" });
    assert.equal(reminder.split("\n").length, 5);
    assert.equal(reminder.includes("has never opened this chat"), true);
    assert.equal(reminder.includes("3 of your messages are unread"), true);
    assert.equal(reminder.includes("run 4 times"), true);
    assert.equal(renderSpendGuardNudgeReminder({ nowMs: now, lastViewedAtMs: now - 60_000, unreadCount: 1, firesSinceViewedCount: 1 }).includes("hasn't opened this chat since"), true);
  });
});
