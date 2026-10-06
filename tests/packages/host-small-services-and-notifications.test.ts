/**
 * Four small pieces of the host: the privacy mode a codebase's telemetry is allowed under, the integrations a listener
 * can be connected for, the marketplace client's own headers and token, and the notifications extension's wiring.
 */

import assert from "node:assert/strict";
import { describe, it } from "node:test";

import {
  createCodebaseTelemetryPrivacyMode,
  isRetryablePrivacyModeLookupError,
  PrivacyModes,
  toPrivacyMode,
} from "../../source/host/extensions/codebase-telemetry/privacy-mode.ts";
import { createListenerIntegrationReads, DASHBOARD_INTEGRATIONS_URL, LISTENER_INTEGRATIONS } from "../../source/host/automations/listener-integrations.automations.ts";
import { bestEffortToken, createMarketplaceInterceptor, CURSOR_MARKETPLACE_REQUEST_TIMEOUT_MS } from "../../source/shared/node/marketplace/cursor-marketplace-client.ts";
import { notificationsExtension } from "../../source/host/notifications/extension.ts";
import { HostExtensions } from "../../source/host/extensions/extension-ids.generated.ts";

const auth = (authId: string) => ({ authId, authToken: `token-${authId}` });

function policies(): {
  lookupDeadline: { run<T>(work: (signal: AbortSignal) => Promise<T>): Promise<T> };
  lookupRetry: { runWithRetry<T>(attempt: (n: number, signal: AbortSignal) => Promise<T>): Promise<T> };
  refreshPolling: { start(): { dispose(): void } };
} {
  return {
    lookupDeadline: { run: (work) => work(new AbortController().signal) },
    lookupRetry: { runWithRetry: (attempt) => attempt(1, new AbortController().signal) },
    refreshPolling: { start: () => ({ dispose: () => {} }) },
  };
}

function privacyWorld(load: (authId: string) => Promise<number> = async () => PrivacyModes.NoTraining) {
  const logged: string[] = [];
  const loads: string[] = [];
  const mode = createCodebaseTelemetryPrivacyMode({
    load: async ({ auth: account }: { auth: { authId: string } }) => {
      loads.push(account.authId);
      return await load(account.authId);
    },
    ...policies(),
    logger: { error: (message: string) => void logged.push(message), warn: (message: string) => void logged.push(message) },
  } as never);
  return { mode, loads, logged };
}

const settle = () => new Promise((resolve) => setTimeout(resolve, 5));

describe("the privacy mode a codebase's telemetry is allowed under", () => {
  it("understands the modes it knows and leaves anything else unspecified", () => {
    assert.deepEqual(
      [PrivacyModes.Unspecified, PrivacyModes.NoStorage, PrivacyModes.NoTraining, PrivacyModes.UsageDataTrainingAllowed, PrivacyModes.UsageCodebaseTrainingAllowed],
      [0, 1, 2, 3, 4],
    );
    assert.deepEqual([1, 2, 3, 4, 0, 99, -1, 1.5].map((value) => toPrivacyMode(value)), [1, 2, 3, 4, 0, 0, 0, 0]);
  });

  it("tries a lookup again only when it timed out or the backend said it may", () => {
    assert.equal(isRetryablePrivacyModeLookupError(new Error("anything")), false);
    assert.equal(isRetryablePrivacyModeLookupError("not an error"), false);
    const deadline = new Error("too slow");
    deadline.name = "DeadlineExceededError";
    assert.equal(isRetryablePrivacyModeLookupError(deadline), true);
    const connect = (code: number, retryAfter: boolean) =>
      Object.assign(new Error("the backend refused"), { name: "ConnectError", code, metadata: { has: (name: string) => retryAfter && name === "retry-after" } });
    assert.deepEqual(
      [connect(4, false), connect(14, false), connect(14, true), connect(13, false)].map((error) => isRetryablePrivacyModeLookupError(error)),
      [true, true, false, false],
    );
  });

  it("reads the mode when an account arrives, clears it when the account leaves, and stays quiet once let go", async () => {
    const world = privacyWorld();
    const seen: number[] = [];
    const subscription = world.mode.receiver.subscribe((value) => seen.push(value));
    assert.equal(world.mode.receiver.get(), PrivacyModes.Unspecified);
    world.mode.setAuth(auth("account-1") as never);
    await settle();
    assert.deepEqual([world.loads, world.mode.receiver.get()], [["account-1"], PrivacyModes.NoTraining]);
    // Setting the same account again reads it again; a new account is read too, and only the first clears the mode.
    world.mode.setAuth(auth("account-1") as never);
    await settle();
    world.mode.setAuth(auth("account-2") as never);
    await settle();
    assert.deepEqual(world.loads, ["account-1", "account-1", "account-2"]);
    world.mode.clearAuth();
    // Every account change clears what was there first, and an account that left takes its mode with it.
    assert.deepEqual([world.mode.receiver.get(), seen], [PrivacyModes.Unspecified, [PrivacyModes.Unspecified, PrivacyModes.NoTraining, PrivacyModes.NoTraining, PrivacyModes.Unspecified, PrivacyModes.NoTraining, PrivacyModes.Unspecified]]);
    subscription.dispose();
    world.mode.dispose();
    // A lookup that failed keeps nothing and says so; a mode the platform does not know is not adopted.
    const failing = privacyWorld(async () => {
      throw new Error("the backend is down");
    });
    failing.mode.setAuth(auth("account-1") as never);
    await settle();
    assert.deepEqual([failing.mode.receiver.get(), failing.logged], [PrivacyModes.Unspecified, ["Privacy mode lookup failed"]]);
    const unknown = privacyWorld(async () => 42);
    unknown.mode.setAuth(auth("account-1") as never);
    await settle();
    assert.equal(unknown.mode.receiver.get(), PrivacyModes.Unspecified);
    // Nothing is looked up after it was let go, and letting go twice is nothing.
    const stopped = privacyWorld();
    stopped.mode.setAuth(auth("account-1") as never);
    await settle();
    stopped.mode.dispose();
    stopped.mode.dispose();
    stopped.mode.setAuth(auth("account-2") as never);
    await settle();
    assert.deepEqual(stopped.loads, ["account-1"]);
  });
});

describe("the integrations a listener can be connected for", () => {
  function listenerWorld(options: { slack?: boolean; scm?: boolean; installUrl?: string | null; readFails?: boolean; installFails?: boolean; showDetail?: boolean } = {}) {
    const logged: string[] = [];
    const reads = createListenerIntegrationReads({
      dashboard: () => ({
        getSlackUserSettings: async () => {
          if (options.readFails === true) throw new Error("the dashboard is down");
          return { hasSlackAuth: options.slack ?? false };
        },
        getScmConnectionStatus: async () => ({ connected: options.scm ?? false }),
        getSlackInstallUrl: async () => {
          if (options.installFails === true) throw new Error("the dashboard is down");
          return { url: options.installUrl === null ? "" : options.installUrl ?? "https://slack.example/install" };
        },
      }),
      transcript: {
        listAllAutomationDefinitions: async () => [{ automation: { isEnabled: true, trigger: { type: "slack", channel: "#general", match: { kind: "message" } } } }, { automation: { isEnabled: false, trigger: { type: "github", repo: "owner/repo", events: ["ci-failed"] } } }],
        getAgentChannels: async () => [{ platform: "slack", name: "one" }, { platform: "other", name: "two" }],
      },
      sourceStatuses: () => new Map(options.showDetail === true ? [["slack", { state: "ready", detail: "listening", scopeIssues: [{ kind: "not-found", scope: "#general" }] }]] : []),
      log: (message: string) => logged.push(message),
    } as never);
    return { reads, logged };
  }

  it("asks the dashboard which platforms are connected, and answers with what each needs", async () => {
    const { reads } = listenerWorld({ slack: true, scm: false });
    assert.deepEqual([await reads.isPlatformConnected("slack"), await reads.isPlatformConnected("github")], [true, false]);
    const { integrations } = await reads.getIntegrations();
    assert.deepEqual(integrations.map((entry) => [entry.platform, entry.isConnected, entry.state, entry.neededByCount]), [
      ["slack", true, "idle", 1],
      ["github", false, "idle", 0],
    ]);
    assert.deepEqual(LISTENER_INTEGRATIONS.map((entry) => entry.platform), ["slack", "github"]);
    // A status the host has is what the entry says, scope issues and all.
    const detailed = listenerWorld({ slack: true, showDetail: true });
    const entry = (await detailed.reads.getIntegrations()).integrations[0];
    assert.deepEqual([entry?.state, entry?.detail, entry?.scopeIssues?.length], ["ready", "listening", 1]);
    // A read that failed is a platform that is not connected, and is said so.
    const degraded = listenerWorld({ readFails: true });
    const failed = await degraded.reads.getIntegrations();
    assert.deepEqual(failed.integrations.map((item) => item.isConnected), [false, false]);
    assert.deepEqual(degraded.logged.length, 1);
    assert.equal(degraded.logged[0]?.includes("degraded to disconnected"), true);
    assert.equal(degraded.logged[0]?.startsWith("slack"), true);
  });

  it("gives each platform somewhere to go, and the connections an agent has", async () => {
    const { reads } = listenerWorld();
    assert.deepEqual([await reads.getConnectUrl("github"), await reads.getConnectUrl("slack")], [DASHBOARD_INTEGRATIONS_URL, "https://slack.example/install"]);
    // An install link that came back empty, or a dashboard that failed, is the integrations page.
    const empty = listenerWorld({ installUrl: null });
    assert.equal(await empty.reads.getConnectUrl("slack"), DASHBOARD_INTEGRATIONS_URL);
    const failing = listenerWorld({ installFails: true });
    assert.equal(await failing.reads.getConnectUrl("slack"), DASHBOARD_INTEGRATIONS_URL);
    const channels = await reads.getAgentChannels("agent-1");
    assert.deepEqual(channels.manifests.map((manifest) => manifest.platform), ["slack", "github"]);
    // Only the connections the platform knows are handed on.
    assert.deepEqual(channels.connections.map((connection) => connection.name), ["one"]);
  });
});

describe("the marketplace client", () => {
  it("keeps a token only when there is one, and puts the platform's own headers on a request", async () => {
    assert.deepEqual([await bestEffortToken(async () => "token"), await bestEffortToken(async () => ""), await bestEffortToken(async () => null)], ["token", undefined, undefined]);
    assert.equal(await bestEffortToken(async () => {
      throw new Error("no token today");
    }), undefined);
    assert.equal(CURSOR_MARKETPLACE_REQUEST_TIMEOUT_MS, 12_000);
    const headers = new Map<string, string>();
    const request = { header: { set: (name: string, value: string) => void headers.set(name, value) } };
    const run = createMarketplaceInterceptor(async () => "token-1", async () => "machine-1", { env: {}, uuid: () => "request-1" })(async () => ({ done: true }));
    const answered = await run(request as never);
    assert.deepEqual(answered, { done: true });
    assert.deepEqual([headers.get("x-ghost-mode"), headers.get("x-request-id"), headers.get("authorization")], ["true", "request-1", "Bearer token-1"]);
    assert.equal(headers.get("x-cursor-checksum")?.endsWith("machine-1"), true);
    // Nothing is asked of the machine, and no token is sent, when neither is there.
    headers.clear();
    await createMarketplaceInterceptor(async () => null)(async () => ({ done: true }))(request as never);
    assert.deepEqual([headers.has("authorization"), headers.has("x-cursor-checksum"), headers.get("x-ghost-mode")], [false, false, "true"]);
  });
});

describe("the notifications extension", () => {
  it("declares itself and listens to what the host says until it is stopped", () => {
    assert.deepEqual([notificationsExtension.id, notificationsExtension.dependencies], [HostExtensions.Notifications, [HostExtensions.Auth]]);
    const listeners: Array<(event: unknown) => void> = [];
    let stopped = 0;
    const started = notificationsExtension.start({
      deps: { [HostExtensions.Auth]: { getAccessToken: async () => "token", getMachineId: async () => "machine" } },
      host: {
        events: {
          subscribe: (listener: (event: unknown) => void) => {
            listeners.push(listener);
            return () => {
              stopped += 1;
            };
          },
        },
      },
      onStop: (teardown: () => void) => void teardown(),
    } as never);
    assert.deepEqual(started, {});
    assert.deepEqual([listeners.length, stopped], [1, 1]);
  });
});
