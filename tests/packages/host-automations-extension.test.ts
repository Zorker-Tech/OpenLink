/**
 * Automations, as the host extension declares it: how long the box says it has been up, the reconcile that waits for
 * a credential, and the surface it hands the host — brought up and taken down with nothing left running.
 */

import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { automationsExtension, getBoxUptimeMs, reconcileWhenAuthenticated, SLATE_BOX_BOOT_STARTED_AT_MS_ENV } from "../../source/host/automations/extension.ts";
import { HostExtensions } from "../../source/host/extensions/extension-ids.generated.ts";

/** Waits long enough for the work a call started to have happened. */
const settled = () => new Promise((resolve) => setTimeout(resolve, 10));

describe("how long the box says it has been up", () => {
  it("reads the boot time the box left behind, and answers nothing when there is none to read", () => {
    const previous = process.env[SLATE_BOX_BOOT_STARTED_AT_MS_ENV];
    try {
      delete process.env[SLATE_BOX_BOOT_STARTED_AT_MS_ENV];
      assert.equal(getBoxUptimeMs(), undefined);
      for (const raw of ["", "   ", "not-a-number", "0", "-5", "Infinity"]) {
        process.env[SLATE_BOX_BOOT_STARTED_AT_MS_ENV] = raw;
        assert.equal(getBoxUptimeMs(), undefined, `for ${JSON.stringify(raw)}`);
      }
      process.env[SLATE_BOX_BOOT_STARTED_AT_MS_ENV] = String(Date.now() - 1_000);
      assert.equal(getBoxUptimeMs()! >= 1_000, true);
      // A boot time that is ahead of the clock is not a negative uptime.
      process.env[SLATE_BOX_BOOT_STARTED_AT_MS_ENV] = String(Date.now() + 60_000);
      assert.equal(getBoxUptimeMs(), 0);
    } finally {
      if (previous === undefined) delete process.env[SLATE_BOX_BOOT_STARTED_AT_MS_ENV];
      else process.env[SLATE_BOX_BOOT_STARTED_AT_MS_ENV] = previous;
    }
  });
});

describe("reconciling once the host is signed in", () => {
  function signInWorld(token: string | null) {
    const renewals: (() => void)[] = [];
    const reconciled: string[] = [];
    let unsubscribed = 0;
    let credential = token;
    const stop = reconcileWhenAuthenticated({
      auth: {
        peekAccessToken: () => credential,
        subscribeToRenewal: (listener) => {
          renewals.push(listener);
          return () => void (unsubscribed += 1);
        },
      },
      reconcile: () => void reconciled.push("reconciled"),
    });
    return { renewals, reconciled, stop, get unsubscribed() { return unsubscribed; }, signIn: (next: string | null) => void (credential = next) };
  }

  it("waits for a credential and reconciles once, however many renewals follow", () => {
    const world = signInWorld(null);
    assert.deepEqual(world.reconciled, []);
    for (const renewal of world.renewals) renewal();
    assert.deepEqual(world.reconciled, []);
    world.signIn("credential");
    for (const renewal of world.renewals) renewal();
    assert.equal(world.reconciled.length, 1);
    for (const renewal of world.renewals) renewal();
    assert.equal(world.reconciled.length, 1);
    world.stop();
    assert.equal(world.unsubscribed, 1);
  });

  it("reconciles at once when a credential is already there", () => {
    const world = signInWorld("credential");
    assert.equal(world.reconciled.length, 1);
  });
});

describe("the automations extension", () => {
  function automationWorld(options: { credential?: string | null } = {}) {
    const teardowns: (() => void | Promise<void>)[] = [];
    const notifySubscriptions: string[] = [];
    const notifyListeners = new Map<string, () => void>();
    const logged: string[] = [];
    let notifyUnsubscribed = 0;
    const deps = {
      auth: {
        getAccessToken: async () => "credential",
        getMachineId: async () => "machine",
        peekAccessToken: () => options.credential ?? null,
        subscribeToRenewal: () => () => {},
      },
      settings: { getUserTimeZone: () => "UTC" },
      telemetry: { logs: { reportHostExtensionDiagnostic: () => {}, reportAutomationShadowPrune: () => {} }, brain: { reportAutomationFireDropped: () => {} } },
      transcript: {
        listAgents: async () => [],
        // One routine the backend schedules: without one, a consumer that already drained while nothing was
        // schedulable stops asking, and the test would no longer see whether it is still running.
        listAllAutomationDefinitions: async () => [{ agentId: "agent-1", automation: { id: "routine-1", name: "Routine", prompt: "run it", isEnabled: true, trigger: { type: "cron", schedule: "0 9 * * *" } } }],
        runAutomationForEvent: async () => undefined,
        runServerScheduledAutomation: async () => undefined,
        runServerAutomationForEvent: async () => undefined,
        getAgentChannels: async () => [],
        resumeAfterListenerConnect: async () => {},
      },
      trays: { pushError: () => ({ id: "tray-1" }), dismiss: () => {} },
      "turn-execution": { isRunReady: () => true },
      "notify-bus": {
        isConnected: () => false,
        isSafetyPollEnabled: () => true,
        onNotify: (topic: string, listener: () => void) => {
          notifySubscriptions.push(topic);
          notifyListeners.set(topic, listener);
          return () => void (notifyUnsubscribed += 1);
        },
      },
    };
    const host = { log: (message: string) => void logged.push(message), events: { on: () => () => {} } };
    // The consumer takes the fetch it will use when it is built, so the stand-in has to be in place before the
    // extension starts — and it keeps this test off the network entirely.
    const asked: string[] = [];
    const realFetch = globalThis.fetch;
    globalThis.fetch = (async (url: string) => {
      asked.push(String(url));
      // A backend that answers a poll with nothing to do: a failed one would put the consumer in backoff, and a
      // consumer in backoff tells us nothing about whether it was stopped.
      return { ok: true, status: 200, json: async () => ({ events: [] }) } as unknown as Response;
    }) as unknown as typeof fetch;
    return {
      deps,
      host,
      teardowns,
      notifySubscriptions,
      logged,
      asked,
      notify: (topic: string) => notifyListeners.get(topic)?.(),
      restoreFetch: () => void (globalThis.fetch = realFetch),
      get notifyUnsubscribed() {
        return notifyUnsubscribed;
      },
    };
  }

  it("says which extension it is, brings its parts up, and hands the host the surface it needs", async () => {
    const world = automationWorld();
    assert.equal(automationsExtension.id, HostExtensions.Automations);
    assert.deepEqual(automationsExtension.dependencies, [HostExtensions.Auth, HostExtensions.Settings, HostExtensions.Telemetry, HostExtensions.Transcript, HostExtensions.Trays, HostExtensions.TurnExecution, HostExtensions.NotifyBus]);
    const api = await automationsExtension.start({ deps: world.deps, host: world.host, onStop: (teardown: () => void | Promise<void>) => void world.teardowns.push(teardown) } as never);
    assert.deepEqual(Object.keys(api).sort(), [
      "deleteAgentSchedules",
      "getAgentChannels",
      "getListenerConnectUrl",
      "getListenerIntegrations",
      "isListenerPlatformConnected",
      "reconcileNow",
      "resumeWakes",
      "sourceStatuses",
      "suspendWakes",
    ]);
    // Both notify topics are subscribed, and the whole surface is callable.
    assert.deepEqual(world.notifySubscriptions, ["automation-fires", "listener-events"]);
    for (const [name, call] of Object.entries(api)) assert.equal(typeof call, "function", name);
    // A reconcile asks the fire consumer for a poll.
    try {
      api.reconcileNow();
      await settled();
      assert.equal(world.asked.length > 0, true);
    } finally {
      world.restoreFetch();
    }
    // Once the wakes are suspended, neither a reconcile nor a notify wakes it again.
    const suspended = automationWorld();
    try {
      const suspendedApi = await automationsExtension.start({ deps: suspended.deps, host: suspended.host, onStop: (teardown: () => void | Promise<void>) => void suspended.teardowns.push(teardown) } as never);
      await settled();
      // Starting asks the backend once.
      assert.equal(suspended.asked.length > 0, true);
      await suspendedApi.suspendWakes();
      const afterSuspend = suspended.asked.length;
      suspendedApi.reconcileNow();
      suspended.notify("automation-fires");
      await settled();
      assert.equal(suspended.asked.length, afterSuspend);
      for (const teardown of suspended.teardowns) await teardown();
    } finally {
      suspended.restoreFetch();
    }
    // Taking the extension down lets go of the notify subscriptions and everything else.
    assert.equal(world.teardowns.length, 3);
    for (const teardown of world.teardowns) await teardown();
    assert.equal(world.notifyUnsubscribed, 2);
  });
});
