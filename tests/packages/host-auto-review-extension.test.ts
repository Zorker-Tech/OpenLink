/**
 * The auto-review, as the host extension declares it: what it says about itself, the service it hands the host, and
 * the expiring-and-sweeping it does before the host is told it is up.
 */

import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { autoReviewExtension, SLATE_AUTO_REVIEW_MODE_ENV } from "../../source/host/extensions/auto-review/extension.ts";
import { SLATE_AUTO_REVIEW_HOST_GENERATION } from "../../source/host/runner/slate-auto-review.ts";
import { HostExtensions } from "../../source/host/extensions/extension-ids.generated.ts";

const tick = () => new Promise((resolve) => setImmediate(resolve));

function extensionWorld(options: { expireFails?: boolean } = {}) {
  const calls: string[] = [];
  const teardowns: (() => void | Promise<void>)[] = [];
  const clears: { agentId: unknown; ifSinceBefore: unknown }[] = [];
  const awaitingSink = {
    clearForTab: (agentId: unknown, _tabId: unknown, options?: { ifSinceBefore?: unknown }) => {
      clears.push({ agentId, ifSinceBefore: options?.ifSinceBefore });
      calls.push(`clear:${String(agentId)}`);
    },
  };
  const transcript = {
    createAwaitingStateSink: () => awaitingSink,
    listAgentIds: async () => {
      calls.push("listAgentIds");
      return ["agent-1", "agent-2"];
    },
    expireAllPendingAutoReviewApprovalCards: async () => {
      calls.push("expire");
      if (options.expireFails === true) throw new Error("the card store is down");
      return {};
    },
  };
  const deps = {
    [HostExtensions.Auth]: { getAccessToken: async () => "token", getMachineId: () => "machine" },
    [HostExtensions.Experiments]: { checkGate: async () => false, checkFeatureGate: () => false, subscribe: () => () => {} },
    [HostExtensions.Settings]: { getAutoReviewInstructions: () => undefined, getUserTimeZone: () => undefined },
    [HostExtensions.Telemetry]: { logs: { reportHostExtensionDiagnostic: () => {}, reportAgentError: () => {} } },
    [HostExtensions.Transcript]: transcript,
  };
  const host = { log: () => {}, events: { on: () => () => {} } };
  return { deps, host, calls, teardowns, clears };
}

describe("the auto-review, as the host extension declares it", () => {
  it("says what it is, builds the review service over the host's own parts, and hands it over", async () => {
    const world = extensionWorld();
    assert.equal(autoReviewExtension.kind, "host-extension");
    assert.equal(autoReviewExtension.id, HostExtensions.AutoReview);
    assert.deepEqual(autoReviewExtension.dependencies, [HostExtensions.Auth, HostExtensions.Experiments, HostExtensions.Settings, HostExtensions.Telemetry, HostExtensions.Transcript]);
    assert.equal(typeof SLATE_AUTO_REVIEW_HOST_GENERATION, "string");
    assert.equal(SLATE_AUTO_REVIEW_MODE_ENV, "SLATE_AUTO_REVIEW_MODE");
    const service = await autoReviewExtension.start({
      deps: world.deps,
      host: world.host,
      onStop: (teardown: () => void | Promise<void>) => void world.teardowns.push(teardown),
    } as never);
    // What the host gets is the review service itself, built with the platform's own generation.
    assert.equal((service as unknown as { deps: { hostGeneration: string } }).deps.hostGeneration, SLATE_AUTO_REVIEW_HOST_GENERATION);
    // What the host gets is the review service itself, and stopping the host stops it.
    assert.deepEqual([typeof service.sweepStaleAwaitingBadges, typeof service.stop, typeof service.bindRunner], ["function", "function", "function"]);
    assert.equal(world.teardowns.length, 1);
    await world.teardowns[0]!();
  });

  it("expires whatever the host's last life left waiting, and sweeps the badges that pointed at it", async () => {
    const world = extensionWorld();
    const before = Date.now();
    await autoReviewExtension.start({ deps: world.deps, host: world.host, onStop: () => {} } as never);
    await tick();
    await tick();
    // The expiring came first, then the sweep cleared every agent's awaiting badge with the moment the host started.
    assert.equal(world.calls[0], "expire");
    assert.deepEqual(world.clears.map((clear) => clear.agentId), ["agent-1", "agent-2"]);
    // The moment a badge is measured against is this host's start, not the beginning of time.
    assert.equal(typeof world.clears[0]!.ifSinceBefore, "number");
    assert.deepEqual([(world.clears[0]!.ifSinceBefore as number) >= before, (world.clears[0]!.ifSinceBefore as number) <= Date.now()], [true, true]);
    assert.equal(world.calls.filter((call) => call === "listAgentIds").length, 1);
  });

  it("sweeps just the same when the expiring failed", async () => {
    const world = extensionWorld({ expireFails: true });
    await autoReviewExtension.start({ deps: world.deps, host: world.host, onStop: () => {} } as never);
    await tick();
    await tick();
    // A sweep that could not expire the cards still clears the badges: a stale badge is worse than a late one.
    assert.deepEqual([world.calls.includes("expire"), world.clears.map((clear) => clear.agentId)], [true, ["agent-1", "agent-2"]]);
  });

  it("reads the local mode from the environment, and runs without one", async () => {
    const previous = process.env[SLATE_AUTO_REVIEW_MODE_ENV];
    try {
      for (const [mode, expected] of [["enforce", "enforce"], ["shadow", "shadow"], ["off", "off"], ["not-a-mode", undefined], [undefined, undefined]] as const) {
        if (mode === undefined) delete process.env[SLATE_AUTO_REVIEW_MODE_ENV];
        else process.env[SLATE_AUTO_REVIEW_MODE_ENV] = mode;
        const world = extensionWorld();
        const service = await autoReviewExtension.start({ deps: world.deps, host: world.host, onStop: () => {} } as never);
        // The mode the service was built with is the one the environment named, and nothing when it named none.
        assert.equal((service as unknown as { deps: { localMode?: string } }).deps.localMode, expected, `for ${String(mode)}`);
      }
    } finally {
      if (previous === undefined) delete process.env[SLATE_AUTO_REVIEW_MODE_ENV];
      else process.env[SLATE_AUTO_REVIEW_MODE_ENV] = previous;
    }
  });
});
