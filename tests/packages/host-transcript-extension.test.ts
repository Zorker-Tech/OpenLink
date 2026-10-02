/**
 * The host extension that starts the transcript: what it declares it needs, the manager it builds over the host's own
 * pieces and the host's data directory, the outline stream it hands the roster, the turn execution it mirrors, what it
 * tells the host while the transcript works, and what happens when the host stops it.
 */

import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import { afterEach, describe, it } from "node:test";

import { transcriptExtension } from "../../source/host/transcript/extension.ts";
import type { TranscriptManager } from "../../source/host/transcript/transcript-manager.ts";
import { RosterProjection } from "../../source/host/transcript/roster-projection.ts";
import { PromptAcceptanceLedger, SLATE_SEND_ACCEPTANCE_FILE_NAME } from "../../source/host/transcript/prompt-acceptance-ledger.ts";
import { SLATE_DATA_ROOT_ENV, getSlateRootDir } from "../../source/host/host-paths.ts";
import { SLATE_ACK_OBLIGATIONS_FILE_NAME, SLATE_PENDING_WAKE_FILE_NAME, SLATE_UPGRADE_RESUME_FILE_NAME } from "../../source/host/durable-file-policy.ts";
import { OUTLINE_STREAM_COALESCE_MS } from "../../source/host/transcript/roster-projection.ts";
import { HostExtensions } from "../../source/host/extensions/extension-ids.generated.ts";

type Call = { name: string; args: unknown[] };

const restores: Array<() => void> = [];
afterEach(() => {
  while (restores.length > 0) restores.pop()?.();
});

/** A host context whose every dependency answers, over a data directory of the test's own. */
function hostWorld(options: { canExecute?: boolean } = {}) {
  const calls: Call[] = [];
  const record = (name: string, ...args: unknown[]) => {
    calls.push({ name, args });
  };
  const root = mkdtempSync(join(tmpdir(), "slate-transcript-ext-"));
  const previous = process.env[SLATE_DATA_ROOT_ENV];
  process.env[SLATE_DATA_ROOT_ENV] = root;
  restores.push(() => {
    if (previous === undefined) delete process.env[SLATE_DATA_ROOT_ENV];
    else process.env[SLATE_DATA_ROOT_ENV] = previous;
  });
  const execution = {
    canExecute: options.canExecute ?? true,
    isRunReady: async () => {
      record("isRunReady");
      return true;
    },
    createRunner: (...args: unknown[]) => {
      record("createRunner", ...args);
      return "runner";
    },
    createGroupMemberRunner: (...args: unknown[]) => {
      record("createGroupMemberRunner", ...args);
      return "member-runner";
    },
  };
  const deps = {
    session: {
      store: {
        setBeingDeletedPredicate: () => record("setBeingDeletedPredicate"),
        cleanupLegacyGroupMemberDirs: () => record("cleanupLegacyGroupMemberDirs"),
        setMemory: (memory: unknown) => record("setMemory", memory),
        closeWorkerPool: async () => record("closeWorkerPool"),
      },
    },
    telemetry: {
      brain: { spans: true },
      analytics: { events: true },
      flushTracing: () => record("flushTracing"),
    },
    memory: { setActiveAgent: (id: unknown) => record("setActiveAgent", id) },
    "content-search": { isSearchReady: true },
    attachments: { ingest: async () => ({ absolutePath: "/x" }) },
    trays: { pushError: () => record("pushError") },
    "turn-execution": execution,
  };
  const teardowns: Array<() => void | Promise<void>> = [];
  const started = transcriptExtension.start({
    deps: deps as never,
    host: { events: { emit: async (topic: string, payload: unknown) => record("emit", topic, payload) } },
    onStop: (teardown: () => void | Promise<void>) => teardowns.push(teardown),
  } as never);
  return { manager: started as unknown as TranscriptManager, deps, execution, root, calls, teardowns, named: (name: string) => calls.filter((call) => call.name === name) };
}

describe("the transcript host extension", () => {
  it("declares itself as the transcript extension and what it needs to start", () => {
    assert.deepEqual([transcriptExtension.id, transcriptExtension.kind], [HostExtensions.Transcript, "host-extension"]);
    assert.deepEqual(transcriptExtension.dependencies, [
      HostExtensions.Attachments,
      HostExtensions.ContentSearch,
      HostExtensions.Memory,
      HostExtensions.Session,
      HostExtensions.Telemetry,
      HostExtensions.Trays,
      HostExtensions.TurnExecution,
    ]);
    assert.equal(Object.isFrozen(transcriptExtension.dependencies), true);
  });

  it("builds the manager over the host's pieces, all rooted under the host's data directory", () => {
    const world = hostWorld();
    assert.equal(getSlateRootDir(), world.root);
    assert.equal(world.manager.sessionStore, world.deps.session.store);
    // The durable stores all keep their files under that same root.
    const files = [
      (world.manager.upgradeResumeStore as unknown as { filePath: string }).filePath,
      (world.manager.ackObligationStore as unknown as { filePath: string }).filePath,
      (world.manager.pendingWakeStore as unknown as { filePath: string }).filePath,
      (world.manager.acceptanceLedger as unknown as { filePath: string }).filePath,
    ];
    assert.deepEqual(
      files.map((file) => basename(file)),
      [SLATE_UPGRADE_RESUME_FILE_NAME, SLATE_ACK_OBLIGATIONS_FILE_NAME, SLATE_PENDING_WAKE_FILE_NAME, SLATE_SEND_ACCEPTANCE_FILE_NAME],
    );
    assert.equal(files.every((file) => file.startsWith(`${world.root}/`)), true);
    assert.equal(world.manager.acceptanceLedger instanceof PromptAcceptanceLedger, true);
    // Everything the host handed over is in place, telemetry and its tracing flusher included.
    assert.deepEqual(
      [world.manager.memory, world.manager.contentSearch, world.manager.attachments, world.manager.trayErrors, world.manager.telemetry, world.manager.productAnalytics],
      [world.deps.memory, world.deps["content-search"], world.deps.attachments, world.deps.trays, world.deps.telemetry.brain, world.deps.telemetry.analytics],
    );
    world.manager.traceFlusher();
    assert.equal(world.named("flushTracing").length, 1);
    assert.equal(world.manager.disposed, false);
  });

  it("hands the roster an outline stream to coalesce", () => {
    assert.equal(OUTLINE_STREAM_COALESCE_MS, 250);
    const original = RosterProjection.prototype.setOutlineStreamCoalescing;
    const policies: Array<{ name: string }> = [];
    RosterProjection.prototype.setOutlineStreamCoalescing = function (policy, clock) {
      policies.push(policy);
      return original.call(this, policy, clock);
    };
    restores.push(() => {
      RosterProjection.prototype.setOutlineStreamCoalescing = original;
    });
    const world = hostWorld();
    assert.deepEqual(policies.map((policy) => policy.name), ["transcript-outline-stream"]);
    // And the roster is showing through a coalescing function now rather than flushing on every update.
    const flush = (world.manager.roster as unknown as { streamOutlineFlush: unknown }).streamOutlineFlush;
    assert.equal(typeof flush, "function");
    assert.equal(typeof (flush as { dispose?: unknown }).dispose, "function");
  });

  it("mirrors the turn execution the host declared, live", async () => {
    const world = hostWorld({ canExecute: false });
    assert.deepEqual([world.manager.execution.canExecute, world.manager.execution.canExecuteGroupMember], [false, false]);
    // What the host can do is asked again at each use, not remembered at start time.
    world.execution.canExecute = true;
    assert.deepEqual([world.manager.execution.canExecute, world.manager.execution.canExecuteGroupMember], [true, true]);
    assert.equal(await world.manager.execution.isRunReady(), true);
    assert.equal(world.manager.execution.createRunner("agent-1", "prompt"), "runner");
    assert.equal(world.manager.execution.createGroupMemberRunner("agent-1", "prompt"), "member-runner");
    assert.deepEqual(world.named("isRunReady").length, 1);
    assert.deepEqual(world.named("createRunner")[0]?.args, ["agent-1", "prompt"]);
    assert.deepEqual(world.named("createGroupMemberRunner")[0]?.args, ["agent-1", "prompt"]);
  });

  it("tells the host what the transcript is doing", () => {
    const world = hostWorld();
    world.manager.automationConfigChanged?.();
    world.manager.onListenerConnectCard?.({ agentId: "agent-1", platform: "slate" });
    world.manager.emitAgentRunLifecycle({ type: "started", requestId: "r1" });
    world.manager.emitAgentRunLifecycle({ type: "ended", requestId: "r2" });
    assert.deepEqual(world.named("emit").map((call) => call.args), [
      ["transcript.automation-config-changed", {}],
      ["transcript.listener-connect-card", { agentId: "agent-1", platform: "slate" }],
      ["transcript.run-started", { requestId: "r1" }],
      ["transcript.run-ended", { requestId: "r2" }],
    ]);
  });

  it("lets the manager go when the host stops it", async () => {
    const world = hostWorld();
    assert.equal(world.teardowns.length, 1);
    await world.teardowns[0]?.();
    assert.equal(world.manager.disposed, true);
    assert.equal(world.named("closeWorkerPool").length, 1);
    // The manager's own watchers are unbound with it.
    assert.equal(world.named("setActiveAgent")[0]?.args[0], null);
  });
});
