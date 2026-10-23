import { test } from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";

import {
  LEARN_SKILL_NAME,
  SlateTeachRecordingError,
  TEACH_PRIVATE_MONITOR_MESSAGE,
  TEACH_QUEUES_DIR,
  TEACH_SESSIONS_DIR,
  createTeachRecordingService,
  isForkWindowIndex,
  learningPromptNonce,
  learningPromptRichText,
  queueFileForSessionDir,
  queueScope,
  signQueueEntry,
  type TeachRecordingDeps,
} from "../../source/host/extensions/teach-recording/teach-recording-service.ts";
import { createContext } from "../../source/packages/context/context.ts";
import { shellExecutorResource } from "../../source/packages/agent-exec/shell.ts";
import { SLATE_BOX_FIRST_FORK_WINDOW_INDEX, SlateBoxNoMonitorAvailableError } from "../../source/host/ports/box.ts";

const KEY = new TextEncoder().encode("queue-signing-key");
const queuedFile = "teach-20250101T000000Z-12345678-1234-1234-1234-123456789abc.json";
const agentId = "agent-1";

function queueEntry(overrides: Record<string, unknown> = {}) {
  const scope = queueScope(agentId);
  const sessionDir = TEACH_SESSIONS_DIR + "/" + queuedFile.slice(0, -5);
  const clientNonce = "teach-recording:" + scope + ":" + queuedFile;
  const signature = signQueueEntry(KEY, agentId, queuedFile);
  return { agentId, sessionDir, clientNonce, signature, ...overrides };
}

function harness(options: {
  enabled?: boolean;
  windowIndex?: number | undefined;
  startFails?: boolean;
  workflow?: boolean;
  verifyFails?: boolean;
  recoveryScan?: string;
  recoverySendFails?: boolean;
  boxFails?: boolean;
  noAccessor?: boolean;
} = {}) {
  const commands: string[] = [];
  const started: Array<Record<string, unknown>> = [];
  const stopped: Array<Record<string, unknown>> = [];
  const failed: Array<Record<string, unknown>> = [];
  const capFailed: Array<Record<string, unknown>> = [];
  const prompts: Array<{ agentId: string; prompt: { content: string; richText: string; clientNonce: string } }> = [];
  let capInstalled: (() => void) | null = null;
  let capDisposed = 0;
  const problems: Error[] = [];
  const shell = {
    async execute(_ctx: unknown, args: { command: string; toolCallId?: string }) {
      commands.push(args.command);
      if (options.startFails === true && args.command.includes("x11grab")) {
        return { result: { case: "success", value: { exitCode: 1, stdout: "start failed", stderr: "" } } };
      }
      if (options.verifyFails === true && args.toolCallId === "slate-teach-recording-verify") {
        return { result: { case: "success", value: { exitCode: 1, stdout: "verify failed", stderr: "" } } };
      }
      if (options.recoveryScan !== undefined && args.command.includes("pending/*.json") && args.command.includes("for queue_file")) {
        return { result: { case: "success", value: { exitCode: 0, stdout: options.recoveryScan, stderr: "" } } };
      }
      return { result: { case: "success", value: { exitCode: 0, stdout: "", stderr: "" } } };
    },
  };
  const connection = options.noAccessor === true ? {} : { remoteAccessor: { get: (resource: unknown) => resource === shellExecutorResource ? shell : undefined } };
  const deps: TeachRecordingDeps = {
    box: {
      async ensureReady() { if (options.boxFails === true) throw new Error("box down"); return connection; },
      getAgentWindowIndex() { return options.windowIndex ?? SLATE_BOX_FIRST_FORK_WINDOW_INDEX; },
    },
    isEnabled() { return options.enabled ?? true; },
    capPolicy: {
      wrap(fn: () => void) {
        capInstalled = fn;
        return Object.assign(() => {}, { dispose() { capDisposed += 1; } }) as (() => void) & { dispose(): void };
      },
    },
    async sendLearningPrompt(id, prompt) {
      prompts.push({ agentId: id, prompt });
      if (options.recoverySendFails === true) throw new Error("send failed");
    },
    async listAgentIds() { return [agentId]; },
    async queueSignatureKey() { return KEY; },
    async ensureLearningWorkflow() { return options.workflow ?? true; },
    trackRecordingStarted(event) { started.push(event); },
    trackRecordingStopped(event) { stopped.push(event); },
    reportStartFailed(event) { failed.push(event); },
    reportCapStopFailed(event) { capFailed.push(event); },
  };
  const service = createTeachRecordingService(deps);
  return { service, commands, started, stopped, failed, capFailed, prompts, problems, installCap: (fn: () => void) => { capInstalled = fn; }, runCap: () => capInstalled?.(), capDisposed: () => capDisposed };
}

test("a fork window is an integer at or above the first fork window", () => {
  assert.equal(isForkWindowIndex(SLATE_BOX_FIRST_FORK_WINDOW_INDEX), true);
  assert.equal(isForkWindowIndex(SLATE_BOX_FIRST_FORK_WINDOW_INDEX + 2), true);
  assert.equal(isForkWindowIndex(SLATE_BOX_FIRST_FORK_WINDOW_INDEX - 1), false);
  assert.equal(isForkWindowIndex(undefined), false);
  assert.equal(isForkWindowIndex(null), false);
  assert.equal(isForkWindowIndex(1.5), false);
  assert.equal(isForkWindowIndex(SLATE_BOX_FIRST_FORK_WINDOW_INDEX + 0.5), false);
});

test("a queue entry has a scope, a file name and a signature", () => {
  assert.equal(queueScope(agentId), createHash("sha256").update(agentId).digest("hex"));
  assert.equal(queueFileForSessionDir("/workspace/teach-sessions/teach-x"), "teach-x.json");
  assert.equal(queueFileForSessionDir("no-slash"), "no-slash.json");
  const signature = signQueueEntry(KEY, agentId, queuedFile);
  assert.match(signature, /^[0-9a-f]{64}$/);
  assert.equal(signQueueEntry(KEY, agentId, queuedFile), signature);
  assert.notEqual(signQueueEntry(KEY, "other", queuedFile), signature);
  const recording = { agentId, startedAtMs: 1, sessionDir: TEACH_SESSIONS_DIR + "/" + queuedFile.slice(0, -5), displayLabel: ":5" };
  assert.equal(learningPromptNonce(recording), queueEntry().clientNonce);
  const rich = JSON.parse(learningPromptRichText(agentId));
  const node = rich.content[0].content[0];
  assert.equal(node.attrs.id, LEARN_SKILL_NAME);
  assert.equal(node.attrs.teachQueueScope, queueScope(agentId));
});

test("a disabled or disposed service refuses to start and reports it", async () => {
  const disabled = harness({ enabled: false });
  await assert.rejects(() => disabled.service.api.start({ agentId }), (error: unknown) =>
    error instanceof SlateTeachRecordingError && (error as SlateTeachRecordingError).kind === "disabled");
  assert.equal(disabled.failed[0]?.kind, "disabled");
  const disposed = harness();
  await disposed.service.dispose();
  await assert.rejects(() => disposed.service.api.start({ agentId }), (error: unknown) =>
    error instanceof SlateTeachRecordingError && (error as SlateTeachRecordingError).kind === "shutting_down");
});

test("an error of the box or of the shell is classified for the report", async () => {
  const boxDown = harness({ boxFails: true });
  const boxOutcome = await boxDown.service.api.start({ agentId }).then(() => "resolved", (error: unknown) => String(error));
  assert.equal(boxOutcome.includes("box down"), true);
  assert.equal(boxDown.failed[0]?.kind, "box");
});

test("a box without a shell accessor cannot be driven", async () => {
  const world = harness({ noAccessor: true });
  const outcome = await world.service.api.start({ agentId }).then(() => "resolved", (error: unknown) => error instanceof Error ? error.message : String(error));
  assert.equal(outcome.includes("box shell accessor is unavailable"), true);
});

test("a service error carries its name and kind", async () => {
  const world = harness({ enabled: false });
  const error = await world.service.api.start({ agentId }).then(() => null, (reason: unknown) => reason as SlateTeachRecordingError);
  assert.equal(error?.name, "SlateTeachRecordingError");
  assert.equal(error?.kind, "disabled");
});

test("a monitor that is not a private desktop refuses to start", async () => {
  const denied = harness({ windowIndex: 1 });
  await assert.rejects(() => denied.service.api.start({ agentId }), (error: unknown) => error instanceof SlateBoxNoMonitorAvailableError && (error as Error).message === TEACH_PRIVATE_MONITOR_MESSAGE);
  assert.equal(denied.failed[0]?.kind, "no_monitor");
});

test("a start records the session, tells the subscriber and reports it", async () => {
  const world = harness();
  const statuses: unknown[] = [];
  const unsubscribe = world.service.api.subscribe((status) => statuses.push(status));
  assert.equal(world.service.api.getStatus().state, "idle");
  const status = await world.service.api.start({ agentId, entryPoint: "/workspace/x" });
  assert.equal(status.state, "recording");
  assert.equal(status.agentId, agentId);
  assert.deepEqual(statuses.at(-1), world.service.api.getStatus());
  assert.equal(world.started.length, 1);
  assert.equal(world.started[0]!.entry_point, "/workspace/x");
  assert.equal(world.commands.some((command) => command.includes("ffmpeg")), true);
  assert.equal(world.commands.some((command) => command.includes("session.json")), true);
  // A second start while one is recording is the same status.
  const again = await world.service.api.start({ agentId });
  assert.equal(again.state, "recording");
  assert.equal(again.agentId, status.agentId);
  unsubscribe();
  await world.service.dispose();
});

test("two starts at once only begin one recording", async () => {
  const world = harness();
  const [first, second] = await Promise.all([world.service.api.start({ agentId }), world.service.api.start({ agentId })]);
  assert.equal(first.state, "recording");
  assert.deepEqual(second, first);
  assert.equal(world.commands.filter((command) => command.includes("x11grab")).length, 1);
  await world.service.dispose();
});

test("a start whose shell command fails cleans up and reports the failure", async () => {
  const world = harness({ startFails: true });
  await assert.rejects(() => world.service.api.start({ agentId }), (error: unknown) =>
    error instanceof SlateTeachRecordingError && (error as SlateTeachRecordingError).kind === "start_failed");
  assert.equal(world.failed.length, 1);
  assert.equal(world.service.api.getStatus().state, "idle");
  await world.service.dispose();
});

test("a saved stop files the recording and sends the learning prompt", async () => {
  const world = harness();
  await world.service.api.start({ agentId });
  const status = await world.service.api.stop({ agentId, save: true });
  assert.equal(status.state, "idle");
  assert.equal(world.commands.some((command) => command.includes("COMPLETED_SESSION_JSON")), true);
  assert.equal(world.commands.some((command) => command.includes("then : > \"$queue_file.prompt-delivered\"")), true);
  assert.equal(world.prompts.length, 1);
  assert.equal(world.prompts[0]!.agentId, agentId);
  assert.equal(world.prompts[0]!.prompt.richText.includes(LEARN_SKILL_NAME), true);
  assert.equal(world.stopped.at(-1)?.outcome, "saved");
  await world.service.dispose();
});

test("a discarded stop cleans the session and sends nothing", async () => {
  const world = harness();
  await world.service.api.start({ agentId });
  const status = await world.service.api.stop({ agentId, save: false });
  assert.equal(status.state, "idle");
  assert.equal(world.prompts.length, 0);
  assert.equal(world.stopped.at(-1)?.outcome, "discarded");
  assert.equal(world.commands.some((command) => command.includes("rm -rf")), true);
  await world.service.dispose();
});

test("stopping another agent's recording is refused", async () => {
  const world = harness();
  await world.service.api.start({ agentId });
  await assert.rejects(() => world.service.api.stop({ agentId: "other", save: true }), (error: unknown) =>
    error instanceof SlateTeachRecordingError && (error as SlateTeachRecordingError).kind === "agent_mismatch");
  await world.service.dispose();
});

test("a missing learning workflow or an unauthentic queue fails the stop", async () => {
  const noWorkflow = harness({ workflow: false });
  await noWorkflow.service.api.start({ agentId });
  const workflowOutcome = await noWorkflow.service.api.stop({ agentId, save: true }).then(() => "resolved", (error: unknown) => error instanceof SlateTeachRecordingError ? error.kind : String(error));
  assert.equal(workflowOutcome, "workflow_unavailable");
  await noWorkflow.service.dispose();
  const badQueue = harness({ verifyFails: true });
  await badQueue.service.api.start({ agentId });
  await assert.rejects(() => badQueue.service.api.stop({ agentId, save: true }), (error: unknown) =>
    error instanceof SlateTeachRecordingError && (error as SlateTeachRecordingError).kind === "finalize_failed");
  await badQueue.service.dispose();
});

test("an idle stop is idle and disposing twice is one teardown", async () => {
  const world = harness();
  assert.deepEqual(await world.service.api.stop({ agentId, save: true }), world.service.api.getStatus());
  assert.equal(world.service.api.getStatus().state, "idle");
  const once = world.service.dispose();
  assert.equal(world.service.dispose(), once);
  await once;
});

test("a recording that ran into its cap stops itself and reports the cap stop", async () => {
  const world = harness();
  await world.service.api.start({ agentId });
  world.runCap();
  await new Promise((resolve) => setTimeout(resolve, 30));
  assert.equal(world.stopped.at(-1)?.outcome, "saved");
  await world.service.dispose();
});

test("recovering pending recordings sends the prompt for a well-signed entry", async () => {
  const content = Buffer.from(JSON.stringify(queueEntry())).toString("base64");
  const scan = queueScope(agentId) + "\t" + queuedFile + "\t0\t" + content + "\n";
  const world = harness({ recoveryScan: scan });
  await world.service.recoverPending();
  assert.equal(world.prompts.length, 1);
  assert.equal(world.prompts[0]!.prompt.clientNonce, queueEntry().clientNonce);
  assert.equal(world.commands.some((command) => command.includes("then : > \"$queue_file.prompt-delivered\"")), true);
  await world.service.dispose();
});

test("a forged pending entry is quarantined and no prompt is sent", async () => {
  const forged = Buffer.from(JSON.stringify(queueEntry({ signature: "0".repeat(64) }))).toString("base64");
  const scan = queueScope(agentId) + "\t" + queuedFile + "\t0\t" + forged + "\n";
  const world = harness({ recoveryScan: scan });
  await world.service.recoverPending();
  assert.equal(world.prompts.length, 0);
  assert.equal(world.commands.some((command) => command.includes("/rejected/")), true);
  await world.service.dispose();
});
test("recovery does nothing when the feature is off or the workflow is missing", async () => {
  const scope = queueScope(agentId);
  const sessionDir = TEACH_SESSIONS_DIR + "/" + queuedFile.slice(0, -5);
  const clientNonce = "teach-recording:" + scope + ":" + queuedFile;
  const signature = signQueueEntry(KEY, agentId, queuedFile);
  const content = Buffer.from(JSON.stringify({ agentId, sessionDir, clientNonce, signature })).toString("base64");
  const scan = scope + "\t" + queuedFile + "\t0\t" + content + "\n";
  const disabled = harness({ recoveryScan: scan, enabled: false });
  await disabled.service.recoverPending();
  assert.equal(disabled.prompts.length, 0);
  assert.equal(disabled.commands.length, 0);
  const noWorkflow = harness({ recoveryScan: scan, workflow: false });
  await noWorkflow.service.recoverPending();
  assert.equal(noWorkflow.prompts.length, 0);
  await disabled.service.dispose();
  await noWorkflow.service.dispose();
});

test("a queued entry with a bad marker, file name or extra column is not recovered", async () => {
  const scope = queueScope(agentId);
  const makeContent = (file: string) => {
    const sessionDir = TEACH_SESSIONS_DIR + "/" + file.slice(0, -5);
    const clientNonce = "teach-recording:" + scope + ":" + file;
    const signature = signQueueEntry(KEY, agentId, file);
    return Buffer.from(JSON.stringify({ agentId, sessionDir, clientNonce, signature })).toString("base64");
  };
  const cases = [
    scope + "\t" + queuedFile + "\t2\t" + makeContent(queuedFile) + "\n",
    scope + "\tbad.json\t0\t" + makeContent("bad.json") + "\n",
    scope + "\t" + queuedFile + "\t0\t" + makeContent(queuedFile) + "\textra\n",
  ];
  for (const scan of cases) {
    const world = harness({ recoveryScan: scan });
    await world.service.recoverPending();
    assert.equal(world.prompts.length, 0);
    await world.service.dispose();
  }
});
