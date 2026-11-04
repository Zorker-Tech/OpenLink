import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  RevivingBackgroundWorkRegistry,
  SHELL_REWATCH_MAX_WAIT_MS,
  SHELL_REWATCH_MISSING_FILE_GIVE_UP,
  SHELL_REWATCH_POLL_DEFAULT_MS,
  createBackgroundWatches,
  deriveBackgroundSubagentTitle,
  formatSteerPrompt,
  parseShellTerminalFooter,
  shellRewatchPollMs,
  type BackgroundWakeup,
  type BackgroundWorkRecord,
  type BackgroundWatchesHost,
} from "../../source/host/runner/background-work.ts";

function record(overrides: Partial<BackgroundWorkRecord> = {}): BackgroundWorkRecord {
  return { id: "work-1", kind: "shell", state: "running", ...overrides };
}

interface WatchHarness {
  watches: ReturnType<typeof createBackgroundWatches>;
  wakes: unknown[];
  settledShell: unknown[];
  settledTasks: unknown[];
  changes: number;
  polls: Array<{ id: string; cancelled(): boolean; settle(status: string, detail?: string, outputPath?: string): void }>;
  cloudCalls: Array<{ id: string; waitForRestart: boolean }>;
  resolveCloud(result: { status: string; text: string }): void;
  rejectCloud(error: unknown): void;
  setCloudEnabled(enabled: boolean): void;
}

function watchHarness(): WatchHarness {
  const wakes: unknown[] = [];
  const settledShell: unknown[] = [];
  const settledTasks: unknown[] = [];
  const polls: WatchHarness["polls"] = [];
  const cloudCalls: WatchHarness["cloudCalls"] = [];
  let changes = 0;
  let cloudEnabled = true;
  let resolveCompletion: ((result: { status: string; text: string }) => void) | undefined;
  let rejectCompletion: ((error: unknown) => void) | undefined;

  const host: BackgroundWatchesHost = {
    getConversationId: () => "parent-agent",
    emitAsyncTasksChanged: () => { changes += 1; },
    pendingWakeArmedHandler: () => event => wakes.push(event),
    backgroundShellSettledHandler: () => event => settledShell.push(event),
    notifyBackgroundWorkSettled: completion => settledTasks.push(completion),
    cloudAgentWatcher: () => cloudEnabled ? {
      awaitCompletion(id, options) {
        cloudCalls.push({ id, waitForRestart: options.waitForRestart });
        return new Promise((resolve, reject) => { resolveCompletion = resolve; rejectCompletion = reject; });
      },
    } : null,
    pollShellTerminalFile: (id, cancelled, settle) => polls.push({ id, cancelled, settle }),
  };

  return {
    watches: createBackgroundWatches(host),
    wakes,
    settledShell,
    settledTasks,
    get changes() { return changes; },
    polls,
    cloudCalls,
    resolveCloud: result => resolveCompletion?.(result),
    rejectCloud: error => rejectCompletion?.(error),
    setCloudEnabled: enabled => { cloudEnabled = enabled; },
  };
}

function settle(): Promise<void> {
  return new Promise(resolve => setImmediate(resolve));
}

describe("background work contract", () => {
  it("publishes bounded shell rewatch defaults", () => {
    assert.equal(SHELL_REWATCH_POLL_DEFAULT_MS, 10_000);
    assert.equal(SHELL_REWATCH_MAX_WAIT_MS, 5 * 60 * 60 * 1_000);
    assert.equal(SHELL_REWATCH_MISSING_FILE_GIVE_UP, 5);
  });

  it("parses a complete terminal footer and preserves integer exit codes", () => {
    assert.deepEqual(parseShellTerminalFooter("output\n---\nexit_code: 0\n---\n"), { isComplete: true, exitCode: 0 });
    assert.deepEqual(parseShellTerminalFooter("output\n---\nexit_code: -7\n---"), { isComplete: true, exitCode: -7 });
    assert.deepEqual(parseShellTerminalFooter("output\n---\nexit_code: 1.5\n---"), { isComplete: true });
    assert.deepEqual(parseShellTerminalFooter("output\n---\nexit_code:\n---"), { isComplete: true });
  });

  it("recognizes only a finished stream-failure footer and leaves partial output pending", () => {
    assert.deepEqual(parseShellTerminalFooter("output\n---\nerror: process lost\nended_at: 2026-10-27\n---"), { isComplete: true, isStreamFailure: true });
    assert.deepEqual(parseShellTerminalFooter("output\n---\nerror: process lost\n---"), { isComplete: false });
    assert.deepEqual(parseShellTerminalFooter("plain output"), { isComplete: false });
  });

  it("parses the polling environment as a positive integer and falls back otherwise", () => {
    assert.equal(shellRewatchPollMs({ SLATE_SHELL_REWATCH_POLL_MS: "250" } as NodeJS.ProcessEnv), 250);
    assert.equal(shellRewatchPollMs({ SLATE_SHELL_REWATCH_POLL_MS: " 125ms " } as NodeJS.ProcessEnv), 125);
    assert.equal(shellRewatchPollMs({ SLATE_SHELL_REWATCH_POLL_MS: "0" } as NodeJS.ProcessEnv), SHELL_REWATCH_POLL_DEFAULT_MS);
    assert.equal(shellRewatchPollMs({ SLATE_SHELL_REWATCH_POLL_MS: "-5" } as NodeJS.ProcessEnv), SHELL_REWATCH_POLL_DEFAULT_MS);
    assert.equal(shellRewatchPollMs({ SLATE_SHELL_REWATCH_POLL_MS: "nope" } as NodeJS.ProcessEnv), SHELL_REWATCH_POLL_DEFAULT_MS);
  });

  it("collapses a background prompt into a bounded title or the default", () => {
    assert.equal(deriveBackgroundSubagentTitle("  check\n the   build  "), "check the build");
    assert.equal(deriveBackgroundSubagentTitle("  \n  "), "Background task");
    const long = deriveBackgroundSubagentTitle("x".repeat(100));
    assert.equal(long.length, 80);
    assert.equal(long.endsWith("…"), true);
  });

  it("formats a steering message as parent context without altering its text", () => {
    assert.equal(formatSteerPrompt("  keep the current plan  "), [
      "[Steering message from the parent agent that dispatched you]",
      "keep the current plan",
      "Take this into account and continue your task from where you are — do not start over.",
    ].join("\n\n"));
  });

  it("upserts by id, filters by kind, and publishes work-set changes", () => {
    let changes = 0;
    const registry = new RevivingBackgroundWorkRegistry(undefined, undefined, () => { changes += 1; });
    registry.upsertWork(record({ id: "one" }));
    registry.upsertWork(record({ id: "two", kind: "cloud-agent", state: "queued" }));
    registry.upsertWork(record({ id: "one", state: "done" }));
    assert.equal(changes, 3);
    assert.equal(registry.hasRunningWork(), false);
    assert.deepEqual(registry.listWork({ kind: "cloud-agent" }).map(item => item.id), ["two"]);
    const copy = registry.listWork();
    copy.pop();
    assert.equal(registry.listWork().length, 2);
  });

  it("clears work even when missing, but aborts and notifies only for an existing record", () => {
    let changes = 0;
    let aborted = 0;
    const registry = new RevivingBackgroundWorkRegistry(undefined, undefined, () => { changes += 1; });
    registry.upsertWork(record({ abort: () => { aborted += 1; } }));
    assert.equal(registry.abortWork("missing"), false);
    assert.equal(registry.abortWork("work-1"), true);
    assert.equal(aborted, 1);
    assert.equal(registry.clearWork("missing"), undefined);
    assert.equal(changes, 3);
    assert.deepEqual(registry.listWork(), []);
  });

  it("aborts only the selected work kind and reports the number removed", () => {
    const aborted: string[] = [];
    const registry = new RevivingBackgroundWorkRegistry();
    registry.upsertWork(record({ id: "shell-a", abort: () => aborted.push("shell-a") }));
    registry.upsertWork(record({ id: "cloud-a", kind: "cloud-agent", abort: () => aborted.push("cloud-a") }));
    registry.upsertWork(record({ id: "shell-b", abort: () => aborted.push("shell-b") }));
    assert.equal(registry.abortAllWork({ kind: "shell" }), 2);
    assert.deepEqual(aborted, ["shell-a", "shell-b"]);
    assert.deepEqual(registry.listWork().map(item => item.id), ["cloud-a"]);
    assert.equal(registry.abortAllWork({ kind: "missing" }), 0);
  });

  it("routes shell completion immediately with its quiet origin and queues progress wakeups", () => {
    const completions: Array<{ item: BackgroundWakeup["payload"]; origin?: string }> = [];
    const registry = new RevivingBackgroundWorkRegistry((item, origin) => completions.push({ item, ...(origin === undefined ? {} : { origin }) }));
    registry.recordWorkOrigin("shell-1", "quiet-origin");
    registry.enqueue({ id: "progress", conversationId: "agent-a", payload: { kind: "shell", reason: "task_progress", taskId: "shell-1", title: "Build" } });
    registry.enqueue({ id: "finished", conversationId: "agent-a", payload: { kind: "shell", reason: "completed", taskId: "shell-1", title: "Build", status: "completed" } });
    assert.equal(registry.pull("agent-a").length, 1);
    assert.equal(registry.pull("agent-b").length, 0);
    assert.deepEqual(completions, [{ item: { kind: "shell", reason: "completed", taskId: "shell-1", title: "Build", status: "completed" }, origin: "quiet-origin" }]);
    registry.enqueue({ payload: { kind: "notice", taskId: "n-1", title: "Notice" } });
    assert.equal(registry.pull("agent-b").length, 1);
  });

  it("acknowledges selected wakeups, suppresses only a matching conversation, and drains completions", () => {
    const registry = new RevivingBackgroundWorkRegistry();
    registry.enqueue({ id: "a", conversationId: "agent-a", payload: { kind: "notice", taskId: "one" } });
    registry.enqueue({ id: "b", conversationId: "agent-b", payload: { kind: "notice", taskId: "two" } });
    registry.enqueue({ payload: { kind: "notice", taskId: "global" } });
    registry.ack(["b"]);
    registry.suppress("agent-a", "a");
    assert.deepEqual(registry.pull("agent-a").map(item => item.payload.taskId), ["global"]);
    registry.enqueueCompletion({ kind: "shell", taskId: "shell-1" });
    registry.enqueueCompletion({ kind: "shell", taskId: "shell-2" });
    assert.equal(registry.hasPendingCompletions("agent-a"), true);
    assert.deepEqual(registry.drainCompletions().map(item => item.taskId), ["shell-1", "shell-2"]);
    assert.equal(registry.hasPendingCompletions("agent-b"), false);
  });

  it("wraps per-turn origin tracking and notifies only for a running shell", () => {
    const armed: Array<{ record: BackgroundWorkRecord; origin?: string }> = [];
    let changes = 0;
    const registry = new RevivingBackgroundWorkRegistry(undefined, (item, origin) => armed.push({ record: item, ...(origin === undefined ? {} : { origin }) }), () => { changes += 1; });
    const turn = registry.forTurn("silent-turn");
    turn.upsertWork(record({ id: "running-shell", kind: "shell", state: "running", metadata: { title: "Run" } }));
    turn.upsertWork(record({ id: "queued-shell", kind: "shell", state: "queued" }));
    turn.upsertWork(record({ id: "running-cloud", kind: "cloud-agent", state: "running" }));
    assert.deepEqual(armed.map(item => [item.record.id, item.origin]), [["running-shell", "silent-turn"]]);
    assert.equal(changes, 3);
    assert.equal(registry.hasPendingCompletions("anyone"), false);
  });

  it("arms one cloud watcher per trimmed id and reports a completion once", async () => {
    const h = watchHarness();
    h.watches.watchCloudAgent("  cloud-1  ", { quietOrigin: "quiet", afterFollowup: true });
    h.watches.watchCloudAgent("cloud-1");
    assert.deepEqual(h.watches.pendingCloudAgentWatchBcIds(), ["cloud-1"]);
    assert.deepEqual(h.cloudCalls, [{ id: "cloud-1", waitForRestart: true }]);
    assert.equal(h.wakes.length, 1);
    h.resolveCloud({ status: "ok", text: "  finished  " });
    await settle();
    assert.deepEqual(h.settledTasks, [{
      parentAgentId: "parent-agent", subagentAgentId: "cloud-1", subagentType: "slate-agent", toolCallId: "", title: "Cloud agent cloud-1",
      quietOrigin: "quiet", status: "completed", result: "finished",
    }]);
    assert.deepEqual(h.watches.pendingCloudAgentWatchBcIds(), []);
  });

  it("normalizes cloud completion failures and substitutes empty result text", async () => {
    const failed = watchHarness();
    failed.watches.watchCloudAgent("cloud-error");
    failed.resolveCloud({ status: "ok", text: "  " });
    await settle();
    assert.match((failed.settledTasks[0] as { result: string }).result, /without producing any output/);

    const rejected = watchHarness();
    rejected.watches.watchCloudAgent("cloud-rejected");
    rejected.rejectCloud({ message: "remote failed" });
    await settle();
    assert.equal((rejected.settledTasks[0] as { status: string }).status, "error");
    assert.equal((rejected.settledTasks[0] as { result: string }).result, "[object Object]");
  });

  it("ignores cloud watches with blank ids or without an available watcher", () => {
    const h = watchHarness();
    h.setCloudEnabled(false);
    h.watches.watchCloudAgent("   ");
    h.watches.watchCloudAgent("cloud-1");
    assert.deepEqual(h.watches.pendingCloudAgentWatchBcIds(), []);
    assert.equal(h.wakes.length, 0);
    assert.equal(h.changes, 0);
  });

  it("rewatches one shell terminal and reports its settled state", () => {
    const h = watchHarness();
    h.watches.watchBackgroundShell(" shell-1 ", { title: "My command", quietOrigin: "quiet" });
    h.watches.watchBackgroundShell("shell-1");
    assert.deepEqual(h.watches.pendingShellRewatchIds(), ["shell-1"]);
    assert.equal(h.polls.length, 1);
    assert.equal(h.wakes.length, 2);
    h.polls[0]?.settle("completed", "done", "/tmp/output.txt");
    assert.deepEqual(h.settledShell, [{
      agentId: "parent-agent", shellId: "shell-1", title: "My command", status: "completed", detail: "done", outputPath: "/tmp/output.txt", quietOrigin: "quiet",
    }]);
    assert.deepEqual(h.watches.pendingShellRewatchIds(), []);
  });

  it("does not poll a shell already present in the reviving registry", () => {
    const h = watchHarness();
    h.watches.registry().forTurn().upsertWork(record({ id: "registered", metadata: { title: "Known shell" } }));
    assert.equal((h.wakes[0] as { title: string }).title, "Known shell");
    h.watches.watchBackgroundShell("registered");
    assert.equal(h.polls.length, 0);
    assert.equal((h.wakes.at(-1) as { title: string }).title, "Background command registered");
  });

  it("cancels shell rewatch callbacks and ignores late settlements", () => {
    const h = watchHarness();
    h.watches.watchBackgroundShell("shell-cancel");
    const poll = h.polls[0];
    assert.ok(poll);
    h.watches.cancelBackgroundShellRewatches();
    assert.equal(poll.cancelled(), true);
    poll.settle("completed");
    assert.deepEqual(h.settledShell, []);
    assert.deepEqual(h.watches.pendingShellRewatchIds(), []);
  });

  it("cancels all background watches and drops late cloud results", async () => {
    const h = watchHarness();
    h.watches.watchBackgroundShell("shell-1");
    h.watches.watchCloudAgent("cloud-1");
    h.watches.registry().upsertWork(record({ id: "registry-shell" }));
    h.watches.cancelBackgroundWatches();
    assert.deepEqual(h.watches.pendingShellRewatchIds(), []);
    assert.deepEqual(h.watches.pendingCloudAgentWatchBcIds(), []);
    h.polls[0]?.settle("completed");
    h.resolveCloud({ status: "ok", text: "late" });
    await settle();
    assert.deepEqual(h.settledShell, []);
    assert.deepEqual(h.settledTasks, []);
  });
});
