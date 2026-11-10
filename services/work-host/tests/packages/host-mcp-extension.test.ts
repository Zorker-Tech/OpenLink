/**
 * MCP, as the host extension declares it: when the plugin skills are read at all, and what the extension writes down
 * as it starts.
 */

import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { mcpExtension, startPluginSkillsWhenAuthenticated, type AuthRenewalPort } from "../../source/host/mcp/extension.ts";
import { reportMcpHostEdgeFailure, pinMcpDiagnosticsReporter } from "../../source/shared/node/mcp/mcp-diagnostics.ts";
import { HostExtensions } from "../../source/host/extensions/extension-ids.generated.ts";

const tick = () => new Promise((resolve) => setImmediate(resolve));

/** An account that hands out a credential and reports its renewals. */
function authWorld(token: string | null, kind: "subscribe" | "onDidChange" = "subscribe") {
  const renewals: ((event: { outcome: string; isFirstCredential?: boolean }) => void)[] = [];
  const changes: (() => void)[] = [];
  const unsubscribed: string[] = [];
  const auth: AuthRenewalPort = {
    peekAccessToken: () => token,
    ...(kind === "subscribe"
      ? {
          subscribeToRenewal: (listener: (event: { outcome: string; isFirstCredential?: boolean }) => void) => {
            renewals.push(listener);
            return () => void unsubscribed.push("renewal");
          },
        }
      : {}),
    onDidChange: (listener: () => void) => {
      changes.push(listener);
      return () => void unsubscribed.push("change");
    },
  };
  return { auth, renewals, changes, unsubscribed, setToken: (next: string | null) => void (token = next) };
}

/** The skills and the polling a start is given. */
function skillsWorld(options: { failSync?: boolean } = {}) {
  const syncs: string[] = [];
  const calls: string[] = [];
  let tickHandler: (() => void | Promise<void>) | undefined;
  const skills = {
    start: () => void calls.push("start"),
    handleAuthChange: () => void calls.push("handleAuthChange"),
    dispose: () => void calls.push("dispose"),
  };
  const service = {
    sync: async (trigger: string) => {
      syncs.push(trigger);
      calls.push(`sync:${trigger}`);
      if (options.failSync === true) throw new Error("the skills could not be read");
      return [];
    },
    handleAuthChange: () => void calls.push("serviceHandleAuthChange"),
  };
  return {
    skills,
    service,
    syncs,
    calls,
    polling: { start: (fn: () => void | Promise<void>) => ((tickHandler = fn), { dispose: () => void calls.push("pollDispose") }) },
    run: async () => await tickHandler?.(),
  };
}

describe("reading the plugin skills once the host is signed in", () => {
  it("starts with a credential in hand, syncs once as the startup and again on every poll", async () => {
    const auth = authWorld("token");
    const world = skillsWorld();
    let succeeded = 0;
    const stop = startPluginSkillsWhenAuthenticated({ auth: auth.auth, service: world.service, pluginSkills: world.skills, polling: world.polling, onStartupSyncSucceeded: () => void (succeeded += 1) });
    // With a credential there is nothing to wait for: the first poll is the startup sync.
    assert.deepEqual(world.syncs, []);
    await world.run();
    assert.deepEqual([world.syncs, succeeded], [["startup"], 1]);
    await world.run();
    await world.run();
    assert.deepEqual([world.syncs, succeeded], [["startup", "refresh", "refresh"], 1]);
    // Taking it down unsubscribes, stops polling and lets the skills go, once.
    stop();
    stop();
    assert.deepEqual([auth.unsubscribed, world.calls.filter((call) => call === "pollDispose").length, world.calls.filter((call) => call === "dispose").length], [["renewal"], 1, 1]);
  });

  it("waits for a credential when the host starts signed out, and starts on the renewal that brings one", async () => {
    const auth = authWorld(null);
    const world = skillsWorld();
    const stop = startPluginSkillsWhenAuthenticated({ auth: auth.auth, service: world.service, pluginSkills: world.skills, polling: world.polling });
    // A renewal that arrives while there is still no credential is not a start.
    auth.renewals[0]!({ outcome: "renewed" });
    await world.run();
    assert.deepEqual([world.syncs, world.calls], [[], []]);
    // Once there is one, the same renewal is what starts the reading.
    auth.setToken("token");
    auth.renewals[0]!({ outcome: "renewed" });
    await world.run();
    assert.deepEqual(world.syncs, ["startup"]);
    // An outcome that is not a renewal is nothing to do.
    auth.renewals[0]!({ outcome: "failed" });
    assert.deepEqual(world.syncs, ["startup"]);
    stop();
  });

  it("tells the skills the account changed when the first credential is renewed", async () => {
    const auth = authWorld("token");
    const world = skillsWorld();
    const stop = startPluginSkillsWhenAuthenticated({ auth: auth.auth, service: world.service, pluginSkills: world.skills, polling: world.polling });
    auth.renewals[0]!({ outcome: "renewed" });
    // An outcome that is not a renewal is nothing to tell the skills about, even as a first credential.
    auth.renewals[0]!({ outcome: "failed", isFirstCredential: true });
    assert.deepEqual(world.calls, []);
    auth.renewals[0]!({ outcome: "renewed", isFirstCredential: true });
    // The service is the one told, not the skills behind it.
    assert.deepEqual(world.calls, ["serviceHandleAuthChange"]);
    stop();
  });

  it("tells the skills themselves when there is no service to tell", () => {
    const auth = authWorld("token");
    const world = skillsWorld();
    const stop = startPluginSkillsWhenAuthenticated({ auth: auth.auth, pluginSkills: world.skills, polling: world.polling });
    auth.renewals[0]!({ outcome: "renewed", isFirstCredential: true });
    assert.deepEqual(world.calls, ["handleAuthChange"]);
    stop();
  });

  it("starts the skills directly when there is no polling to wait for", () => {
    const auth = authWorld("token");
    const world = skillsWorld();
    const stop = startPluginSkillsWhenAuthenticated({ auth: auth.auth, service: world.service, pluginSkills: world.skills });
    assert.deepEqual([world.calls, world.syncs], [["start"], []]);
    stop();
  });

  it("takes an account that only reports changes as one whose first credential is a renewal", () => {
    const auth = authWorld("token", "onDidChange");
    const world = skillsWorld();
    const stop = startPluginSkillsWhenAuthenticated({ auth: auth.auth, service: world.service, pluginSkills: world.skills, polling: world.polling });
    auth.changes[0]!();
    assert.deepEqual(world.calls, ["serviceHandleAuthChange"]);
    stop();
    assert.deepEqual(auth.unsubscribed, ["change"]);
  });

  it("leaves a sync that failed for the next poll", async () => {
    const auth = authWorld("token");
    const world = skillsWorld({ failSync: true });
    let succeeded = 0;
    const stop = startPluginSkillsWhenAuthenticated({ auth: auth.auth, service: world.service, pluginSkills: world.skills, polling: world.polling, onStartupSyncSucceeded: () => void (succeeded += 1) });
    await world.run();
    // A startup sync that failed is not a startup the host acts on.
    assert.deepEqual([world.syncs, succeeded], [["startup"], 0]);
    stop();
  });

  it("does not act on a startup sync that finished after it was taken down", async () => {
    const auth = authWorld("token");
    const world = skillsWorld();
    let release: (() => void) | undefined;
    const held = new Promise<void>((resolve) => (release = resolve));
    const heldService = { sync: async (trigger: string) => ((world.syncs.push(trigger)), await held, []) };
    let succeeded = 0;
    const stop = startPluginSkillsWhenAuthenticated({ auth: auth.auth, service: heldService, pluginSkills: world.skills, polling: world.polling, onStartupSyncSucceeded: () => void (succeeded += 1) });
    const running = world.run();
    stop();
    release!();
    await running;
    assert.deepEqual([world.syncs, succeeded], [["startup"], 0]);
  });
});

describe("the MCP extension", () => {
  function extensionWorld(options: { cleanup?: { outcome: "not_found" | "error" | "deleted"; removedCount: number } | Error; startupFails?: boolean; withSweep?: boolean } = {}) {
    const logs: Array<[string, ...unknown[]]> = [];
    const calls: string[] = [];
    const auth = authWorld("token");
    let tickHandler: (() => void | Promise<void>) | undefined;
    const api = { management: {}, mcp: {} };
    // The plugin skills are one object: it is started, it reads, it answers a change, and it lets go of itself.
    const skills = {
      syncs: [] as string[],
      start: () => void calls.push("skillsStart"),
      sync: async (trigger: string) => {
        skills.syncs.push(trigger);
        if (options.startupFails === true) throw new Error("the skills could not be read");
        return [];
      },
      handleAuthChange: () => void calls.push("skillsHandleAuthChange"),
      dispose: () => void calls.push("skillsDispose"),
    };
    const context = {
      deps: {
        auth: auth.auth,
        telemetry: {
          logs: {
            reportHostExtensionDiagnostic: (event: unknown) => void logs.push(["diagnostic", event]),
            reportMcpAuthCleanup: (outcome: string, removedCount: number) => void logs.push(["cleanup", outcome, removedCount]),
          },
        },
      },
      createPluginSkills: () => (calls.push("createPluginSkills"), skills),
      createPolling: () => (calls.push("createPolling"), { start: (fn: () => void | Promise<void>) => ((tickHandler = fn), { dispose: () => void calls.push("pollDispose") }) }),
      createService: () => (calls.push("createService"), { api, dispose: async () => void calls.push("serviceDispose") }),
      createSkillPublish: () => (calls.push("createSkillPublish"), { publish: true }),
      ...(options.cleanup === undefined
        ? {}
        : options.cleanup instanceof Error
          ? {
              cleanupLegacyAuth: async () => {
                throw options.cleanup;
              },
            }
          : { cleanupLegacyAuth: async () => options.cleanup as { outcome: "not_found" | "error" | "deleted"; removedCount: number } }),
      ...(options.withSweep === true ? { sweepLegacyReferences: async () => void calls.push("sweep") } : {}),
    };
    return { context, logs, calls, skills, api, runTick: async () => await tickHandler?.() };
  }

  it("declares what it is and what it needs", () => {
    assert.equal(mcpExtension.id, HostExtensions.Mcp);
    assert.deepEqual(mcpExtension.dependencies, [HostExtensions.Auth, HostExtensions.Experiments, HostExtensions.ForeverBox, HostExtensions.Settings, HostExtensions.Telemetry]);
  });

  it("writes down what the old layout's cleanup found, and hands the host the service's surface", async () => {
    const world = extensionWorld({ cleanup: { outcome: "deleted", removedCount: 2 } });
    const teardowns: (() => void | Promise<void>)[] = [];
    const started = (await mcpExtension.start({ ...world.context, onStop: (teardown: () => void | Promise<void>) => void teardowns.push(teardown) } as never)) as { skillPublish: unknown; mcp: unknown };
    assert.deepEqual([world.logs, world.calls], [[["cleanup", "ok", 2]], ["createPluginSkills", "createPolling", "createService", "createSkillPublish"]]);
    // The surface is the service's own, with the skill publish beside it.
    assert.deepEqual([started.mcp, started.skillPublish], [world.api.mcp, { publish: true }]);
    // A diagnostic from any MCP edge is written down as this extension's.
    reportMcpHostEdgeFailure("backend-list-tools", new Error("the backend refused"));
    assert.deepEqual(world.logs[1], ["diagnostic", { extension: "mcp", leg: "backend-list-tools", errorClass: "Error" }]);
    // Taking it down stops the startup, lets the skills go and then the service.
    await teardowns[0]!();
    assert.deepEqual(world.calls.slice(4), ["pollDispose", "skillsDispose", "serviceDispose"]);
  });

  it("says a cleanup that failed, and starts anyway", async () => {
    const world = extensionWorld({ cleanup: { outcome: "error", removedCount: 0 } });
    await mcpExtension.start({ ...world.context, onStop: () => {} } as never);
    assert.deepEqual(world.logs, [["cleanup", "error", 0]]);
    const broken = extensionWorld({ cleanup: new Error("the root could not be read") });
    await assert.doesNotReject(() => Promise.resolve(mcpExtension.start({ ...broken.context, onStop: () => {} } as never)));
    assert.deepEqual([broken.logs, broken.calls.includes("createService")], [[], true]);
    pinMcpDiagnosticsReporter(null);
  });

  it("sweeps the old layout's references after the first skills sync that worked", async () => {
    const world = extensionWorld({ withSweep: true });
    await mcpExtension.start({ ...world.context, onStop: () => {} } as never);
    assert.deepEqual(world.calls.includes("sweep"), false);
    await world.runTick();
    assert.deepEqual([world.skills.syncs, world.calls.includes("sweep")], [["startup"], true]);
    pinMcpDiagnosticsReporter(null);
  });
});
