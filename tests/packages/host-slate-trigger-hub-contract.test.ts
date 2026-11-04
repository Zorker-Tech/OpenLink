import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { SlateTriggerHub, type ScheduledAutomation, type TriggerSource } from "../../source/host/automations/slate-trigger-hub.ts";
import type { AutomationTrigger, EventTrigger } from "../../source/shared/automations.ts";
import type { PollingPolicy } from "../../source/host/extensions/scheduling.ts";

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((complete) => { resolve = complete; });
  return { promise, resolve };
}

function slack(channel: string, match: "mention" | "message" = "mention"): EventTrigger {
  return { type: "slack", channel, match: { kind: match } };
}

function github(repo: string): EventTrigger {
  return { type: "github", repo, events: ["pr-opened"] };
}

function automation(
  agentId: string,
  id: string,
  trigger: AutomationTrigger,
  isEnabled = true,
): ScheduledAutomation {
  return { agentId, automation: { id, isEnabled, trigger } };
}

function source(kind: string, options: { failStarts?: number[]; failStop?: boolean } = {}) {
  const assignedListeners: EventTrigger[][] = [];
  let startCount = 0;
  let stopCount = 0;
  let accept: ((event: Record<string, unknown>) => boolean) | undefined;
  const source: TriggerSource = {
    kind,
    setListeners: (listeners) => { assignedListeners.push([...listeners]); },
    start: async (handler) => {
      startCount += 1;
      accept = handler;
      if (options.failStarts?.includes(startCount)) throw new Error(`start ${kind} failed`);
    },
    stop: async () => {
      stopCount += 1;
      if (options.failStop) throw new Error(`stop ${kind} failed`);
    },
    getStatus: () => ({ state: "connected", detail: kind }),
  };
  return {
    source,
    assignedListeners,
    get startCount() { return startCount; },
    get stopCount() { return stopCount; },
    accept: (event: Record<string, unknown>) => accept?.(event) ?? false,
  };
}

function polling() {
  const ticks: Array<() => Promise<void>> = [];
  let starts = 0;
  let disposals = 0;
  const policy: PollingPolicy = {
    name: "test polling",
    start: (tick) => {
      starts += 1;
      ticks.push(tick);
      return { dispose: () => { disposals += 1; } };
    },
  };
  return {
    policy,
    get starts() { return starts; },
    get disposals() { return disposals; },
    tick: async () => { await ticks[0]?.(); },
  };
}

interface WorldOptions {
  sources?: ReturnType<typeof source>[];
  automations?: readonly ScheduledAutomation[];
  isReady?: () => boolean | Promise<boolean>;
  listAutomations?: () => Promise<readonly ScheduledAutomation[]>;
  shouldScheduleLocally?: (agentId: string, automation: ScheduledAutomation["automation"]) => boolean;
  failFireIds?: ReadonlySet<string>;
}

function world(options: WorldOptions = {}) {
  const sources = options.sources ?? [source("slack"), source("github"), source("microsoftTeams")];
  const poll = polling();
  const fired: Array<{ agentId: string; automationId?: string; event: Record<string, unknown> }> = [];
  const reconcileCalls: number[] = [];
  let listCalls = 0;
  const deps = {
    polling: poll.policy,
    sources: sources.map(({ source: item }) => item),
    listAutomations: async () => {
      listCalls += 1;
      return options.listAutomations === undefined ? options.automations ?? [] : options.listAutomations();
    },
    fire: async (agentId: string, scheduled: ScheduledAutomation["automation"], event: Record<string, unknown>) => {
      fired.push({ agentId, ...(scheduled.id === undefined ? {} : { automationId: scheduled.id }), event });
      if (scheduled.id !== undefined && options.failFireIds?.has(scheduled.id)) throw new Error(`fire ${scheduled.id} failed`);
    },
    isReady: options.isReady ?? (() => true),
    ...(options.shouldScheduleLocally === undefined ? {} : { shouldScheduleLocally: options.shouldScheduleLocally }),
    onReconcile: () => { reconcileCalls.push(Date.now()); },
  };
  return {
    hub: new SlateTriggerHub(deps),
    sources,
    poll,
    fired,
    reconcileCalls,
    get listCalls() { return listCalls; },
  };
}

describe("Slate trigger hub behavior contract", () => {
  it("collects only enabled, local Slack and GitHub listeners in automation order", async () => {
    const grouped: AutomationTrigger = {
      type: "group",
      listeners: [slack("C1"), { type: "cron", schedule: "0 9 * * *" }, github("owner/repo")],
    };
    const h = world({
      automations: [
        automation("a1", "one", grouped),
        automation("a2", "disabled", slack("C2"), false),
        automation("a3", "remote", github("other/repo")),
        automation("a4", "cron", { type: "cron", schedule: "0 10 * * *" }),
      ],
      shouldScheduleLocally: (agentId) => agentId !== "a3",
    });

    const desired = await h.hub.desiredListenersByKind();
    assert.deepEqual([...desired], [["slack", [slack("C1")]], ["github", [github("owner/repo")]]]);
  });

  it("sets each source's listener snapshot, starts active sources once, and reconciles status", async () => {
    const h = world({ automations: [automation("a1", "one", slack("C1")), automation("a2", "two", github("owner/repo"))] });
    await h.hub.reconcileNow();
    await h.hub.reconcileNow();

    assert.deepEqual(h.sources.map((item) => item.assignedListeners), [
      [[slack("C1")], [slack("C1")]],
      [[github("owner/repo")], [github("owner/repo")]],
      [],
    ]);
    assert.deepEqual(h.sources.map((item) => [item.startCount, item.stopCount]), [[1, 0], [1, 0], [0, 0]]);
    assert.deepEqual([...h.hub.getSourceStatuses()], [
      ["slack", { state: "connected", detail: "slack" }],
      ["github", { state: "connected", detail: "github" }],
      ["microsoftTeams", { state: "connected", detail: "microsoftTeams" }],
    ]);
    assert.equal(h.reconcileCalls.length, 2);
  });

  it("stops sources whose listeners disappear or while the hub is not ready", async () => {
    let ready = true;
    let automations: readonly ScheduledAutomation[] = [automation("a1", "one", slack("C1"))];
    const h = world({ automations, isReady: () => ready });
    await h.hub.reconcileNow();
    ready = false;
    await h.hub.reconcileNow();
    assert.equal(h.sources[0]?.stopCount, 1);
    assert.deepEqual(h.sources[0]?.assignedListeners, [[slack("C1")]]);

    ready = true;
    automations = [];
    const next = world({ automations, isReady: () => ready });
    await next.hub.reconcileNow();
    assert.equal(next.sources.every((item) => item.startCount === 0), true);
  });

  it("retries a source after its first startup fails", async () => {
    const flaky = source("slack", { failStarts: [1] });
    const h = world({ sources: [flaky], automations: [automation("a1", "one", slack("C1"))] });
    await h.hub.reconcileNow();
    await h.hub.reconcileNow();
    assert.equal(flaky.startCount, 2);
    assert.equal(flaky.stopCount, 0);
    assert.deepEqual(flaky.assignedListeners, [[slack("C1")], [slack("C1")]]);
  });

  it("starts polling once and skips poll-triggered reconciliation while a pass is pending", async () => {
    const listStarted = deferred<void>();
    const releaseList = deferred<readonly ScheduledAutomation[]>();
    const h = world({
      listAutomations: () => { listStarted.resolve(); return releaseList.promise; },
    });
    h.hub.start();
    h.hub.start();
    const pendingPass = h.hub.reconcileNow();
    await listStarted.promise;
    await h.poll.tick();
    assert.equal(h.poll.starts, 1);
    assert.equal(h.listCalls, 1);
    assert.equal(h.reconcileCalls.length, 1);
    releaseList.resolve([]);
    await pendingPass;
    await h.hub.stop();
    assert.equal(h.poll.disposals, 1);
  });

  it("waits for an in-flight readiness check before stopping and does not start a source late", async () => {
    const entered = deferred<void>();
    const release = deferred<boolean>();
    const h = world({
      automations: [automation("a1", "one", slack("C1"))],
      isReady: () => { entered.resolve(); return release.promise; },
    });
    const pass = h.hub.reconcileNow();
    await entered.promise;
    let stopped = false;
    const stopping = h.hub.stop().then(() => { stopped = true; });
    await Promise.resolve();
    assert.equal(stopped, false);
    release.resolve(true);
    await Promise.all([pass, stopping]);
    assert.equal(h.sources[0]?.startCount, 0);
    assert.equal(stopped, true);
  });

  it("isolates a failed source stop and removes its started state", async () => {
    const active = source("slack", { failStop: true });
    const h = world({ sources: [active], automations: [automation("a1", "one", slack("C1"))] });
    await h.hub.reconcileNow();
    await h.hub.stop();
    await h.hub.stop();
    assert.equal(active.startCount, 1);
    assert.equal(active.stopCount, 1);
  });

  it("dispatches only ready, enabled, matching and locally scheduled events, isolating fire errors", async () => {
    const h = world({
      automations: [
        automation("a1", "first", slack("C1")),
        automation("a2", "other-room", slack("C2")),
        automation("a3", "disabled", slack("C1"), false),
        automation("a4", "remote", slack("C1")),
        automation("a5", "second", slack("C1")),
      ],
      shouldScheduleLocally: (agentId) => agentId !== "a4",
      failFireIds: new Set(["first"]),
    });
    await h.hub.handleEvent({ source: "slack", channel: "C1", isMention: true });
    assert.deepEqual(h.fired.map((fire) => [fire.agentId, fire.automationId]), [["a1", "first"], ["a5", "second"]]);
  });

  it("does not list automations while stopped or not ready", async () => {
    let ready = false;
    const h = world({ automations: [automation("a1", "one", slack("C1"))], isReady: () => ready });
    await h.hub.handleEvent({ source: "slack", channel: "C1", isMention: true });
    assert.equal(h.listCalls, 0);
    ready = true;
    await h.hub.stop();
    await h.hub.handleEvent({ source: "slack", channel: "C1", isMention: true });
    assert.equal(h.listCalls, 0);
    assert.deepEqual(h.fired, []);
  });

  it("accepts asynchronous source events only while active", async () => {
    const h = world({ automations: [automation("a1", "one", slack("C1"))] });
    await h.hub.reconcileNow();
    const event = { source: "slack", channel: "C1", isMention: true };
    assert.equal(h.sources[0]?.accept(event), true);
    await new Promise((resolve) => setTimeout(resolve, 0));
    assert.equal(h.fired.length, 1);
    await h.hub.stop();
    assert.equal(h.sources[0]?.accept(event), false);
  });

  it("treats an automation-list failure as an empty event pass", async () => {
    const h = world({ listAutomations: async () => { throw new Error("list failed"); } });
    await h.hub.handleEvent({ source: "slack", channel: "C1", isMention: true });
    assert.deepEqual(h.fired, []);
  });
});
