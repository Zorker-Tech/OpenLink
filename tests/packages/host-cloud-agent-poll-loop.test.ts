/**
 * Watching a cloud agent: how a run's own vocabulary is read, what a caller is told when it ends, which saved
 * environment a launch meant, and what the watcher does with slow polls, rate limits and its own deadline.
 */

import assert from "node:assert/strict";
import { describe, it } from "node:test";

import {
  availableEnvironmentsNote,
  buildWatchResult,
  CLOUD_AGENT_MAX_WAIT_MS,
  CLOUD_AGENT_POLL_INTERVAL_MS,
  CLOUD_AGENT_POLL_RPC_TIMEOUT_MS,
  CLOUD_AGENT_RATE_LIMIT_FALLBACK_MS,
  CLOUD_AGENT_RUN_RESTART_GRACE_MS,
  CloudAgentCompletionPoller,
  CloudAgentModelCatalogCache,
  CloudAgentTeamAdminPolicyCache,
  cloudAgentRateLimitPauseMs,
  formatDiffStats,
  MAX_LISTED_SAVED_ENVIRONMENTS,
  MODEL_CATALOG_TTL_MS,
  resolveSavedEnvironment,
  resolveSlateLimitError,
  SAVED_ENVIRONMENT_LIST_LIMIT,
  TEAM_ADMIN_POLICY_TTL_MS,
  type CloudAgentCompletion,
  type DetailedCloudAgent,
} from "../../source/host/cloud-agents/cloud-agent-poll-loop.ts";

const environment = (name: string, publicId: string) => ({ name, publicId });

/** A watch that never settles is a failure, not a hang: the answer is read against the platform's own pace. */
async function settled(completion: Promise<CloudAgentCompletion>): Promise<CloudAgentCompletion | "never settled"> {
  return await Promise.race([completion, new Promise<"never settled">((resolve) => setTimeout(() => resolve("never settled"), 2_000).unref?.())]);
}

/** What one poll answers with: the response's composer is the detailed record, and the run's status sits inside it. */
const detailedWith = (status: number, overrides: DetailedCloudAgent = {}) => ({ composer: { ...overrides, composer: { ...overrides.composer, status } } });

describe("how a run's own vocabulary is read", () => {
  it("answers with what the wire's numbers mean", () => {
    assert.deepEqual([1, 2, 3, 4, 5, 6].map((status) => buildWatchResult("bc-1", status).text.split("\n")[0]), [
      "The Slate agent finished.",
      "The Slate agent finished.",
      "The Slate agent (bc-1) errored before finishing.",
      "The Slate agent finished.",
      "The Slate agent (bc-1) expired before finishing.",
      "The Slate agent finished.",
    ]);
    assert.equal(buildWatchResult("bc-1", "running" as never).status, "completed");
  });

  it("waits out a rate limit for as long as it asked, plus a little", () => {
    assert.equal(cloudAgentRateLimitPauseMs({ retryAfterMs: 1_000 }, () => 0), 1_000);
    assert.equal(cloudAgentRateLimitPauseMs({ retryAfterMs: 1_000 }, () => 1), 1_250);
    assert.equal(cloudAgentRateLimitPauseMs({}, () => 0), CLOUD_AGENT_RATE_LIMIT_FALLBACK_MS);
    assert.equal(cloudAgentRateLimitPauseMs("not an error", () => 0), CLOUD_AGENT_RATE_LIMIT_FALLBACK_MS);
    assert.deepEqual([CLOUD_AGENT_MAX_WAIT_MS, CLOUD_AGENT_POLL_INTERVAL_MS, CLOUD_AGENT_POLL_RPC_TIMEOUT_MS, CLOUD_AGENT_RUN_RESTART_GRACE_MS, SAVED_ENVIRONMENT_LIST_LIMIT, MAX_LISTED_SAVED_ENVIRONMENTS, MODEL_CATALOG_TTL_MS, TEAM_ADMIN_POLICY_TTL_MS], [18_000_000, 10_000, 30_000, 180_000, 500, 25, 300_000, 300_000]);
  });

  it("tells the caller where to find the environments it could have meant", () => {
    assert.equal(availableEnvironmentsNote([]), " This account has no saved environments; create one from the Cloud Agents dashboard in Slate.");
    assert.equal(availableEnvironmentsNote([environment("Primary", "env-1"), environment("   ", "env-2")]), " Available: Primary (env-1), env-2.");
    const many = availableEnvironmentsNote(Array.from({ length: 30 }, (_unused, index) => environment(`E${index}`, `env-${index}`)));
    assert.match(many, /^ Available: E0 \(env-0\), /);
    assert.match(many, /\(\+5 more; set environment\.id to launch one that isn't listed\)\.$/);
  });
});

describe("what a caller is told when a watch ends", () => {
  it("tells a finished run apart from one that errored or expired, with what it did", () => {
    const finished = buildWatchResult("bc-1", 2, {
      composer: { branchName: "feat/x", prUrl: "https://pr.test/1", commitCount: 2, filesChanged: 3, linesAdded: 10, linesRemoved: 4 },
      summary: "  All done.  ",
    });
    assert.deepEqual(finished, {
      status: "completed",
      text: ["The Slate agent finished.", "Branch: feat/x", "Pull request: https://pr.test/1", "Changes: 2 commits, +10/-4 across 3 files.", "", "Summary from the Slate agent:", "All done."].join("\n"),
    });
    // A run whose pull request came from the list rather than the composer still has one.
    const listed = buildWatchResult("bc-1", 2, { composer: { commitCount: 1, filesChanged: 1, linesAdded: 1, linesRemoved: 0 }, prs: [{ prUrl: "https://pr.test/2" }] });
    assert.match(listed.text, /Pull request: https:\/\/pr\.test\/2/);
    assert.match(listed.text, /Changes: 1 commit, \+1\/-0 across 1 file\./);
    // A run that changed nothing says so rather than pretending.
    assert.equal(buildWatchResult("bc-1", 2, {}).text, ["The Slate agent finished.", "No pull request link is available yet (the agent may have made no changes, or the PR is still being created)."].join("\n"));
    assert.deepEqual([formatDiffStats(undefined), formatDiffStats({ composer: {} }), formatDiffStats({ composer: { commitCount: 0, filesChanged: 0 } })], [undefined, undefined, undefined]);
  });

  it("says what the platform's own limit was, when that is why it stopped", () => {
    const limited: DetailedCloudAgent = { permanentError: { details: { title: "  Limit reached  ", detail: "  Your plan's included usage is used up.  ", additionalInfo: { rateLimitReason: "slate_included_limit" } } } };
    assert.equal(resolveSlateLimitError(limited), "Limit reached\nYour plan's included usage is used up.");
    assert.equal(resolveSlateLimitError({ permanentError: { details: { title: "Other", detail: "no", additionalInfo: { rateLimitReason: "something_else" } } } }), null);
    assert.equal(resolveSlateLimitError({}), null);
    assert.equal(resolveSlateLimitError(null), null);
    assert.deepEqual(buildWatchResult("bc-1", 3, limited), { status: "error", text: "The Slate agent (bc-1) errored before finishing.\n\nLimit reached\nYour plan's included usage is used up." });
    // An expiry says expired, not errored.
    assert.match(buildWatchResult("bc-1", 5, {}).text, /^The Slate agent \(bc-1\) expired before finishing\./);
  });
});

describe("which saved environment a launch meant", () => {
  const client = (values: readonly { name: string; publicId: string }[], byId: readonly { name: string; publicId: string }[] = values) => ({
    getEnvironment: async ({ publicId }: { publicId: string }) => {
      const found = byId.find((value) => value.publicId === publicId);
      return found == null ? {} : { environment: found };
    },
    listEnvironments: async ({ limit }: { includeRepositoryScopeEnvironments: true; limit: number }) => ({ environments: limit === 500 ? values : values.slice(0, limit) }),
  });

  it("finds one by id, and one by name however it was spelled", async () => {
    const world = client([environment("Primary", "env-1"), environment("Secondary", "env-2")]);
    assert.deepEqual(await resolveSavedEnvironment(world, { publicId: " env-2 " }), environment("Secondary", "env-2"));
    assert.deepEqual(await resolveSavedEnvironment(world, { name: "  primary  " }), environment("Primary", "env-1"));
    // An id that is not there lists what is; a name that is not there does the same.
    await assert.rejects(resolveSavedEnvironment(world, { publicId: "env-9" }), /No saved environment with id 'env-9'\. Available: Primary \(env-1\), Secondary \(env-2\)\./);
    await assert.rejects(resolveSavedEnvironment(world, { name: "nowhere" }), /No saved environment named 'nowhere'\. Available: Primary \(env-1\), Secondary \(env-2\)\./);
    // A name two environments share is not one this launcher may choose between.
    await assert.rejects(resolveSavedEnvironment(client([environment("Same", "env-1"), environment("same", "env-2")]), { name: "SAME" }), /Multiple saved environments are named 'SAME'\. Set environment\.id to one of: env-1, env-2\./);
    // Nothing to look for at all.
    await assert.rejects(resolveSavedEnvironment(world, {}), /requires the environment's public id or name/);
    await assert.rejects(resolveSavedEnvironment(world, { name: "   " }), /requires the environment's public id or name/);
    const emptyAccount = await resolveSavedEnvironment(client([]), { publicId: "env-1" }).then(() => "no refusal", (error: Error) => error.message);
    assert.match(emptyAccount, /no saved environments; create one/);
  });
});

describe("the two caches", () => {
  it("answers with the catalog it was handed for testing, and holds its own time to the platform's", async () => {
    const now = () => 1_000;
    const catalog = [{ id: "model-one" }];
    const cache = new CloudAgentModelCatalogCache({ clock: { monotonicNow: now }, getAccessToken: async () => "token", getMachineId: async () => "machine", modelCatalogForTesting: catalog as never });
    // A catalog handed in for testing is the one answered with, and no fetch is attempted for it.
    assert.deepEqual(await cache.listModels(), catalog);
    assert.deepEqual(await cache.listModels(), catalog);
    assert.equal(TEAM_ADMIN_POLICY_TTL_MS, MODEL_CATALOG_TTL_MS);
  });

  it("answers whether the team turned cloud agents off, and keeps the last word when it cannot be read", async () => {
    let now = 100;
    let loads = 0;
    let answer: { disableCloudAgentsInSand?: boolean } | "throws" = { disableCloudAgentsInSand: true };
    const cache = new CloudAgentTeamAdminPolicyCache({ clock: { monotonicNow: () => now }, load: async () => (loads += 1, answer === "throws" ? Promise.reject(new Error("the team policy is unreachable")) : answer) });
    // Before anything was read, the answer is "not disabled" — and the read has been started, once.
    assert.equal(cache.isDisabledByTeamAdmin(), false);
    cache.prefetchTeamAdminPolicy();
    assert.equal(loads, 1);
    await new Promise((resolve) => setTimeout(resolve, 10));
    assert.equal(cache.isDisabledByTeamAdmin(), true);
    // A policy that is fresh enough is not read again.
    assert.equal(loads, 1);
    now += TEAM_ADMIN_POLICY_TTL_MS + 1;
    answer = "throws";
    cache.prefetchTeamAdminPolicy();
    await new Promise((resolve) => setTimeout(resolve, 10));
    assert.equal(loads, 2);
    // A read that failed leaves the last answer standing rather than guessing.
    assert.equal(cache.isDisabledByTeamAdmin(), true);
    // A first read that failed is not a guess either: nothing said the team turned agents off.
    let reads = 0;
    const unanswered = new CloudAgentTeamAdminPolicyCache({ clock: { monotonicNow: () => 0 }, load: async () => (reads += 1, Promise.reject(new Error("the team policy is unreachable"))) });
    assert.equal(unanswered.isDisabledByTeamAdmin(), false);
    await new Promise((resolve) => setTimeout(resolve, 10));
    assert.deepEqual([reads, unanswered.isDisabledByTeamAdmin()], [1, false]);
  });
});

describe("the watcher", () => {
  function watchWorld(options: { maxWaitMs?: number; runRestartGraceMs?: number; answers?: (tick: number) => Promise<{ composer?: DetailedCloudAgent }> | { composer?: DetailedCloudAgent }; isRateLimitError?: (error: unknown) => boolean } = {}) {
    let now = 0;
    const ticks: (() => Promise<void>)[] = [];
    const disposed: number[] = [];
    let tickCount = 0;
    const poller = new CloudAgentCompletionPoller(
      {
        completionPolling: { start: (run) => (ticks.push(async () => await run()), { dispose: () => void disposed.push(ticks.length) }) },
        clock: { monotonicNow: () => now },
        ...(options.maxWaitMs === undefined ? {} : { maxWaitMs: options.maxWaitMs }),
        ...(options.runRestartGraceMs === undefined ? {} : { runRestartGraceMs: options.runRestartGraceMs }),
        randomFn: () => 0,
        ...(options.isRateLimitError === undefined ? {} : { isRateLimitError: options.isRateLimitError }),
      },
      () => ({ getBackgroundComposerInfo: async () => (await (options.answers?.(tickCount++) ?? detailedWith(2))) as { composer?: DetailedCloudAgent } }),
    );
    return {
      poller,
      ticks,
      disposed,
      advance: (ms: number) => void (now += ms),
      tick: async () => {
        const run = ticks[0]!;
        await run();
      },
    };
  }

  it("starts by scheduling, keeps waiting for a status it does not know, then answers once the run really ended", async () => {
    const seen: number[] = [];
    const world = watchWorld({
      answers: (tick) => {
        seen.push(tick);
        // The first two answers are a status this platform does not know: the run is not over yet.
        return detailedWith(tick < 2 ? 9 : 2, { composer: { status: tick < 2 ? 9 : 2, branchName: "feat/x" } });
      },
    });
    const watching = world.poller.awaitCompletion("bc-1");
    // The first tick is the schedule starting — the run has just been asked for, so nothing is asked of the backend.
    await world.tick();
    assert.deepEqual(seen, []);
    await world.tick();
    await world.tick();
    // A status this platform does not know is not the end of the run, so the watch is still polling for it.
    assert.deepEqual([seen, world.disposed.length], [[0, 1], 0]);
    await world.tick();
    // Every tick asked until the run really ended.
    assert.deepEqual(seen, [0, 1, 2]);
    assert.deepEqual(await settled(watching), { status: "completed", text: "The Slate agent finished.\nBranch: feat/x\nNo pull request link is available yet (the agent may have made no changes, or the PR is still being created)." });
    // The poll it was given is let go once it answered.
    assert.equal(world.disposed.length, 1);
  });

  it("waits for a run to restart when it was asked to, and gives up on the wait when the platform's ceiling is reached", async () => {
    const restarting = watchWorld({ answers: (tick) => detailedWith(tick < 2 ? 1 : 2), runRestartGraceMs: 1_000, maxWaitMs: 10_000 });
    const watching = restarting.poller.awaitCompletion("bc-1", { waitForRestart: true });
    await restarting.tick();
    await restarting.tick();
    await restarting.tick();
    await restarting.tick();
    assert.equal((await settled(watching)) === "never settled" ? "never settled" : (await settled(watching) as CloudAgentCompletion).status, "completed");
    // A run that never restarted is finished once the grace for the restart is over, rather than waited for forever.
    const neverRestarted = watchWorld({ answers: () => detailedWith(2), runRestartGraceMs: 1_000, maxWaitMs: 100_000 });
    const watched = neverRestarted.poller.awaitCompletion("bc-3", { waitForRestart: true });
    await neverRestarted.tick();
    await neverRestarted.tick();
    assert.equal(await settled(watched), "never settled");
    neverRestarted.advance(1_001);
    await neverRestarted.tick();
    const answered = await settled(watched);
    assert.equal(answered === "never settled" ? "never settled" : answered.status, "completed");
    // A run that never finishes runs out of the platform's own patience.
    const stuck = watchWorld({ answers: () => detailedWith(1), maxWaitMs: 60_000 });
    const waiting = stuck.poller.awaitCompletion("bc-2");
    await stuck.tick();
    await stuck.tick();
    stuck.advance(60_001);
    await stuck.tick();
    assert.deepEqual(await settled(waiting), { status: "error", text: "The Slate agent (bc-2) is still running after 1 minutes. It keeps running on the VM; check the Slate cloud agents dashboard for the result." });
  });

  it("keeps waiting out a rate limit rather than giving up, and reports a check that failed unexpectedly", async () => {
    let now = 0;
    const ticks: (() => Promise<void>)[] = [];
    let answers = 0;
    const poller = new CloudAgentCompletionPoller(
      { completionPolling: { start: (run) => (ticks.push(async () => await run()), { dispose: () => {} }) }, clock: { monotonicNow: () => now }, randomFn: () => 0, isRateLimitError: (error: unknown) => (error as { limited?: boolean }).limited === true, maxWaitMs: 100_000 },
      () => ({
        getBackgroundComposerInfo: async () => {
          answers += 1;
          if (answers === 1) throw Object.assign(new Error("slow down"), { limited: true, retryAfterMs: 5_000 });
          return detailedWith(2);
        },
      }),
    );
    const watching = poller.awaitCompletion("bc-1");
    await ticks[0]!();
    await ticks[0]!();
    await ticks[0]!();
    // The rate-limited poll paused the watcher: a tick before the pause is over does not ask again.
    assert.equal(answers, 1);
    now += 5_001;
    await ticks[0]!();
    const answered = await settled(watching);
    assert.deepEqual([answers, answered === "never settled" ? "never settled" : answered.status], [2, "completed"]);
    // A status check that failed for any other reason is not the end of the watch: the next tick that answers
    // normally is the one that decides, so a flaky backend does not end a run that is still going.
    let flaky = 0;
    const broken = watchWorld({
      answers: () => {
        flaky += 1;
        if (flaky === 1) throw new Error("the backend fell over");
        return detailedWith(2);
      },
    });
    const watchingBroken = broken.poller.awaitCompletion("bc-3");
    await broken.tick();
    await broken.tick();
    await broken.tick();
    const brokenAnswer = await settled(watchingBroken);
    assert.equal(brokenAnswer === "never settled" ? "never settled" : brokenAnswer.status, "completed");
    // Disposing the poller lets go of every watch it started.
    const many = watchWorld();
    void many.poller.awaitCompletion("bc-4");
    void many.poller.awaitCompletion("bc-5");
    many.poller.dispose();
    assert.equal(many.disposed.length, 2);
  });

  it("settles active watches when disposed and refuses future watches", async () => {
    const world = watchWorld({ answers: () => detailedWith(1), maxWaitMs: 100_000 });
    const waiting = world.poller.awaitCompletion("bc-stop");
    world.poller.dispose();

    const stopped = {
      status: "error",
      text: "Stopped watching the Slate agent (bc-stop) before it finished. The run may still be active; check the Slate cloud agents dashboard for its result.",
    };
    assert.deepEqual(await settled(waiting), stopped);
    assert.deepEqual(await world.poller.awaitCompletion("bc-later"), {
      status: "error",
      text: "Stopped watching the Slate agent (bc-later) before it finished. The run may still be active; check the Slate cloud agents dashboard for its result.",
    });
    assert.deepEqual(world.disposed, [1]);
    assert.equal(world.ticks.length, 1)
  });
});
