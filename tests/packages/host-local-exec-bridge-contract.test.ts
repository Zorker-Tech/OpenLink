import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { createContext } from "../../source/packages/context/context.ts";
import type { Clock, IdleWatchdogPolicy } from "../../source/host/extensions/scheduling.ts";
import {
  DEFAULT_SLATE_COMPUTER_ID,
  SlateLocalExecBridge,
  SUPERVISED_RANK,
  TELEMETRY_VARIANTS,
  VARIANT_RANKS,
  boundedLocalExecVariant,
  localExecProviderRank,
  type LocalExecBridgeFrame,
  type LocalExecProviderReport,
  type LocalExecRefusedReport,
} from "../../source/host/local-exec/local-exec-bridge.ts";
import { SlateLocalExecError } from "../../source/host/local-exec/local-exec-error.ts";
import { SLATE_LOCAL_EXEC_LIVENESS_WINDOW_MS, SLATE_NO_LOCAL_MACHINE_MESSAGE, slateComputerUnavailableMessage } from "../../source/shared/local-exec-gateway.ts";

interface BridgeHarness {
  bridge: SlateLocalExecBridge;
  providerReports: LocalExecProviderReport[];
  refusedReports: LocalExecRefusedReport[];
  watchdog: { arms: number; kicks: number; disposals: number; fire: (() => void) | undefined };
  now(): number;
  setNow(value: number): void;
  addProvider(send?: (frame: LocalExecBridgeFrame) => void): { id: string; frames: LocalExecBridgeFrame[]; detach: () => void };
  hello(providerId: string, values?: Record<string, unknown>): void;
}

function harness(options: { blockedReason?: () => string | undefined } = {}): BridgeHarness {
  let time = 100;
  let ids = 0;
  const clock: Clock = {
    now: () => time,
    monotonicNow: () => time,
    schedule: () => ({ dispose() {} }),
  };
  const watchdog = { arms: 0, kicks: 0, disposals: 0, fire: undefined as (() => void) | undefined };
  const responseWatchdog: IdleWatchdogPolicy = {
    name: "bridge-contract",
    arm(onIdle) {
      watchdog.arms += 1;
      watchdog.fire = onIdle;
      return {
        kick() { watchdog.kicks += 1; },
        dispose() { watchdog.disposals += 1; },
      };
    },
  };
  const providerReports: LocalExecProviderReport[] = [];
  const refusedReports: LocalExecRefusedReport[] = [];
  const bridge = new SlateLocalExecBridge({
    clock,
    responseWatchdog,
    blockedReason: options.blockedReason ?? (() => undefined),
    report: {
      provider: report => providerReports.push(report),
      refused: report => refusedReports.push(report),
    },
    randomId: () => `bridge-id-${++ids}`,
  });
  return {
    bridge,
    providerReports,
    refusedReports,
    watchdog,
    now: () => time,
    setNow: value => { time = value; },
    addProvider(send) {
      const frames: LocalExecBridgeFrame[] = [];
      const detach = bridge.registerProvider(frame => {
        frames.push(frame);
        send?.(frame);
      });
      const welcome = frames.find(frame => frame.kind === "welcome");
      assert.ok(welcome && typeof welcome.providerId === "string");
      return { id: welcome.providerId, frames, detach };
    },
    hello(providerId, values = {}) {
      bridge.submitResponses({ providerId, frames: [{ kind: "hello", localRoot: "/machine", terminalsFolder: "/machine/terminals", protocolVersion: 1, ...values }] });
    },
  };
}

function settle(): Promise<void> {
  return new Promise(resolve => setImmediate(resolve));
}

describe("local-exec bridge contract", () => {
  it("publishes stable provider ranks and bounded telemetry variant names", () => {
    assert.equal(DEFAULT_SLATE_COMPUTER_ID, "this-computer");
    assert.equal(SUPERVISED_RANK, 4);
    assert.deepEqual(VARIANT_RANKS, { slate: 2, "slate-lab": 1 });
    assert.deepEqual([...TELEMETRY_VARIANTS].sort(), ["slate", "slate-dev", "slate-lab"]);
    assert.equal(localExecProviderRank({ supervised: true, variant: "slate" }), 6);
    assert.equal(localExecProviderRank({ supervised: false, variant: "slate-lab" }), 1);
    assert.equal(localExecProviderRank({ supervised: true, variant: "unlisted" }), 4);
    assert.equal(boundedLocalExecVariant("slate-dev"), "slate-dev");
    assert.equal(boundedLocalExecVariant("unlisted"), "unknown");
    assert.equal(boundedLocalExecVariant(undefined), undefined);
  });

  it("welcomes each registered provider and reports idempotent detach state", () => {
    const h = harness();
    const provider = h.addProvider();
    assert.deepEqual(provider.frames[0], { kind: "welcome", providerId: provider.id, protocolVersion: 1 });
    assert.equal(h.bridge.hasProvider(), true);
    assert.deepEqual(h.providerReports[0], { phase: "registered", providerId: provider.id, providerCount: 1 });
    provider.detach();
    provider.detach();
    assert.equal(h.bridge.hasProvider(), false);
    assert.deepEqual(h.providerReports[1], {
      phase: "detached", providerId: provider.id, providerCount: 0, ageMs: 0,
      hadHello: false, hasHeartbeat: false, wasLive: true, emptied: true,
    });
  });

  it("stores hello metadata and reports only bounded provider details", () => {
    const h = harness();
    const provider = h.addProvider();
    h.setNow(125);
    h.hello(provider.id, { computerId: "desk-1", label: "Desk", supervised: true, variant: "unlisted" });
    assert.deepEqual(h.bridge.listComputers(), [{ id: "desk-1", label: "Desk", connected: true }]);
    assert.deepEqual(h.bridge.getProviderInfo(), { localRoot: "/machine", terminalsFolder: "/machine/terminals" });
    assert.deepEqual(h.providerReports.at(-1), {
      phase: "hello", providerId: provider.id, providerCount: 1, helloDelayMs: 25,
      computerIdPresent: true, rehello: false, protocolVersion: 1, supervised: true, variant: "unknown",
    });
  });

  it("uses the platform computer id and label until the provider names its own", () => {
    const h = harness();
    h.addProvider();
    assert.deepEqual(h.bridge.listComputers(), [{ id: DEFAULT_SLATE_COMPUTER_ID, label: "this computer", connected: true }]);
    assert.deepEqual(h.bridge.activeComputer(), { id: DEFAULT_SLATE_COMPUTER_ID, label: "this computer", connected: true });
  });

  it("treats a provider as live until it opts into heartbeat expiry", () => {
    const h = harness();
    const provider = h.addProvider();
    h.setNow(100 + SLATE_LOCAL_EXEC_LIVENESS_WINDOW_MS * 4);
    assert.equal(h.bridge.isComputerLive(DEFAULT_SLATE_COMPUTER_ID), true);
    h.bridge.submitResponses({ providerId: provider.id, frames: [{ kind: "ping" }] });
    assert.equal(h.bridge.isComputerLive(DEFAULT_SLATE_COMPUTER_ID), true);
    h.setNow(h.now() + SLATE_LOCAL_EXEC_LIVENESS_WINDOW_MS);
    assert.equal(h.bridge.isComputerLive(DEFAULT_SLATE_COMPUTER_ID), true);
    h.setNow(h.now() + 1);
    assert.equal(h.bridge.isComputerLive(DEFAULT_SLATE_COMPUTER_ID), false);
  });

  it("chooses the highest-ranked live provider and uses heartbeat recency to break rank ties", () => {
    const h = harness();
    const first = h.addProvider();
    h.hello(first.id, { computerId: "desk-a", label: "Ranked", supervised: true, variant: "slate-lab" });
    h.setNow(110);
    const second = h.addProvider();
    h.hello(second.id, { computerId: "desk-b", label: "Fresh", supervised: true, variant: "slate-lab" });
    assert.equal(h.bridge.activeComputer()?.id, "desk-b");
    h.setNow(120);
    h.bridge.submitResponses({ providerId: first.id, frames: [{ kind: "ping", supervised: true }] });
    assert.equal(h.bridge.activeComputer()?.id, "desk-a");
  });

  it("groups providers by computer id and exposes the newest provider's label and liveness", () => {
    const h = harness();
    const first = h.addProvider();
    h.hello(first.id, { computerId: "desk", label: "Old label" });
    h.setNow(130);
    const second = h.addProvider();
    h.hello(second.id, { computerId: "desk", label: "New label" });
    assert.deepEqual(h.bridge.listComputers(), [{ id: "desk", label: "New label", connected: true }]);
    h.bridge.submitResponses({ providerId: second.id, frames: [{ kind: "ping" }] });
    h.setNow(130 + SLATE_LOCAL_EXEC_LIVENESS_WINDOW_MS + 1);
    assert.deepEqual(h.bridge.listComputers(), [{ id: "desk", label: "New label", connected: false }]);
  });

  it("falls back to the most recently registered provider's info when all are stale", () => {
    const h = harness();
    const old = h.addProvider();
    h.hello(old.id, { localRoot: "/old", terminalsFolder: "/old/t", computerId: "old" });
    h.bridge.submitResponses({ providerId: old.id, frames: [{ kind: "ping" }] });
    h.setNow(110);
    const recent = h.addProvider();
    h.hello(recent.id, { localRoot: "/recent", terminalsFolder: "/recent/t", computerId: "recent" });
    h.bridge.submitResponses({ providerId: recent.id, frames: [{ kind: "ping" }] });
    h.setNow(h.now() + SLATE_LOCAL_EXEC_LIVENESS_WINDOW_MS + 1);
    assert.equal(h.bridge.activeComputer(), undefined);
    assert.deepEqual(h.bridge.getProviderInfo(), { localRoot: "/recent", terminalsFolder: "/recent/t" });
  });

  it("reports and rejects a request when no provider has ever registered", () => {
    const h = harness();
    assert.throws(() => h.bridge.assertComputerAvailable(undefined, { site: "shell", agentId: "agent-1" }), error => {
      assert.ok(error instanceof SlateLocalExecError);
      assert.equal(error.message, SLATE_NO_LOCAL_MACHINE_MESSAGE);
      return true;
    });
    assert.deepEqual(h.refusedReports, [{
      cause: "no_providers", site: "shell", conversationId: "agent-1", providerCount: 0,
      liveProviderCount: 0, everRegistered: false, emptyForMs: 0,
    }]);
  });

  it("distinguishes an unknown computer from a known computer with an expired heartbeat", () => {
    const h = harness();
    const provider = h.addProvider();
    h.hello(provider.id, { computerId: "desk", label: "Studio" });
    assert.throws(() => h.bridge.assertComputerAvailable("missing", { site: "read" }), error => {
      assert.ok(error instanceof SlateLocalExecError);
      assert.equal(error.message, SLATE_NO_LOCAL_MACHINE_MESSAGE);
      return true;
    });
    h.bridge.submitResponses({ providerId: provider.id, frames: [{ kind: "ping" }] });
    h.setNow(h.now() + SLATE_LOCAL_EXEC_LIVENESS_WINDOW_MS + 1);
    assert.throws(() => h.bridge.assertComputerAvailable("desk", { site: "read" }), error => {
      assert.ok(error instanceof SlateLocalExecError);
      assert.equal(error.message, slateComputerUnavailableMessage("Studio"));
      return true;
    });
    assert.deepEqual(h.refusedReports.map(report => report.cause), ["computer_unknown", "stale_heartbeat"]);
  });

  it("reports why the ask gate cannot find a live provider", () => {
    const h = harness();
    assert.equal(h.bridge.checkLiveComputerForAsk("agent-1"), false);
    assert.deepEqual(h.refusedReports[0], {
      cause: "no_providers", site: "ask_gate", conversationId: "agent-1", providerCount: 0,
      liveProviderCount: 0, everRegistered: false, emptyForMs: 0,
    });
    const provider = h.addProvider();
    h.bridge.submitResponses({ providerId: provider.id, frames: [{ kind: "ping" }] });
    h.setNow(h.now() + SLATE_LOCAL_EXEC_LIVENESS_WINDOW_MS + 1);
    assert.equal(h.bridge.checkLiveComputerForAsk(), false);
    assert.equal(h.refusedReports.at(-1)?.cause, "stale_heartbeat");
  });

  it("checks a closed local-tool gate before resolving a provider", async () => {
    const h = harness({ blockedReason: () => "Local tools are turned off." });
    await assert.rejects(async () => {
      for await (const _frame of h.bridge.request({ signal: new AbortController().signal }, { kind: "read" })) { /* consume */ }
    }, error => {
      assert.ok(error instanceof SlateLocalExecError);
      assert.equal(error.message, "Local tools are turned off.");
      return true;
    });
    assert.deepEqual(h.refusedReports, []);
  });

  it("routes by computer id, correlates frames, and cancels when the consumer closes", async () => {
    const h = harness();
    const provider = h.addProvider();
    h.hello(provider.id, { computerId: "desk", label: "Desk" });
    const stream = h.bridge.request({ signal: new AbortController().signal, agentId: "agent-7" }, { kind: "read", path: "/note.txt" }, "desk");
    const next = stream.next();
    await settle();
    const request = provider.frames.find(frame => frame.kind === "read");
    assert.ok(request && typeof request.requestId === "string");
    assert.equal(request.path, "/note.txt");
    h.bridge.submitResponses({ providerId: provider.id, frames: [{ kind: "piece", requestId: "another-request", text: "ignore" }] });
    let received = false;
    void next.then(() => { received = true; });
    await settle();
    assert.equal(received, false);
    h.bridge.submitResponses({ providerId: provider.id, frames: [
      { kind: "piece", requestId: request.requestId, text: "first" },
      { kind: "piece", requestId: request.requestId, text: "second" },
    ] });
    assert.deepEqual(await next, { done: false, value: { kind: "piece", requestId: request.requestId, text: "first" } });
    assert.deepEqual(await stream.next(), { done: false, value: { kind: "piece", requestId: request.requestId, text: "second" } });
    await stream.return(undefined);
    assert.equal(provider.frames.some(frame => frame.kind === "cancel" && frame.requestId === request.requestId), true);
  });

  it("does not send a request whose context was already aborted", async () => {
    const h = harness();
    const provider = h.addProvider();
    const [context, cancel] = createContext().withCancel();
    cancel("stop before dispatch");
    const stream = h.bridge.request({ signal: context.signal }, { kind: "read", path: "/never" });
    assert.deepEqual(await stream.next(), { done: true, value: undefined });
    assert.equal(provider.frames.some(frame => frame.kind === "read" || frame.kind === "cancel"), false);
  });

  it("cancels a live request once when its context is cancelled", async () => {
    const h = harness();
    const provider = h.addProvider();
    const [context, cancel] = createContext().withCancel();
    const stream = h.bridge.request({ signal: context.signal }, { kind: "read" });
    const next = stream.next();
    await settle();
    const request = provider.frames.find(frame => frame.kind === "read");
    assert.ok(request && typeof request.requestId === "string");
    cancel("caller left");
    assert.deepEqual(await next, { done: true, value: undefined });
    assert.equal(provider.frames.filter(frame => frame.kind === "cancel" && frame.requestId === request.requestId).length, 1);
  });

  it("arms and kicks the response watchdog, then refuses a response that never arrives", async () => {
    const h = harness();
    const provider = h.addProvider();
    h.hello(provider.id, { label: "Studio" });
    const stream = h.bridge.request({ signal: new AbortController().signal }, { kind: "exec" }, undefined, { watchResponse: true });
    const pending = stream.next();
    await settle();
    assert.equal(h.watchdog.arms, 1);
    const request = provider.frames.find(frame => frame.kind === "exec");
    assert.ok(request && typeof request.requestId === "string");
    h.bridge.submitResponses({ providerId: provider.id, frames: [{ kind: "chunk", requestId: request.requestId }] });
    assert.equal((await pending).done, false);
    assert.equal(h.watchdog.kicks, 1);
    const waiting = stream.next();
    h.watchdog.fire?.();
    await assert.rejects(waiting, error => {
      assert.ok(error instanceof SlateLocalExecError);
      assert.equal(error.message, slateComputerUnavailableMessage("Studio"));
      return true;
    });
    assert.equal(h.watchdog.disposals, 1);
    assert.equal(provider.frames.some(frame => frame.kind === "cancel" && frame.requestId === request.requestId), true);
  });

  it("does not arm the response watchdog when a caller opts out", async () => {
    const h = harness();
    const provider = h.addProvider();
    const stream = h.bridge.request({ signal: new AbortController().signal }, { kind: "exec" });
    const pending = stream.next();
    await settle();
    const request = provider.frames.find(frame => frame.kind === "exec");
    assert.ok(request && typeof request.requestId === "string");
    h.bridge.submitResponses({ providerId: provider.id, frames: [{ kind: "done", requestId: request.requestId }] });
    assert.equal((await pending).done, false);
    assert.equal(h.watchdog.arms, 0);
    await stream.return(undefined);
  });

  it("retires an approval across all providers and isolates send failures", () => {
    const h = harness();
    const first = h.addProvider(() => { throw new Error("closed"); });
    const second = h.addProvider();
    h.bridge.retireApproval("approval-9");
    assert.equal(first.frames.some(frame => frame.kind === "retire-approval" && frame.approvalId === "approval-9"), true);
    assert.deepEqual(second.frames.at(-1), { kind: "retire-approval", requestId: "bridge-id-4", approvalId: "approval-9" });
  });
});
