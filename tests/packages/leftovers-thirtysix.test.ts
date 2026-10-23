/**
 * A turn's observation, the subagent runtime and the worker pool agents' work runs in.
 */

import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { createTurnObservation, MCP_EXEC_STALL_THRESHOLD_MS } from "../../source/host/runner/turn-observation.ts";
import { computeSubagentRequestId, createSubagentRuntime, subagentSteerRunOptions } from "../../source/host/runner/subagent-runtime.ts";
import { AgentWorkerConnection, AgentWorkerPool, DEFAULT_IDLE_TIMEOUT_MS, DEFAULT_MAX_WORKERS, DEFAULT_SWEEP_INTERVAL_MS, MAX_FORWARDED_WORKER_LINE_BYTES } from "../../source/host/agents/isolation/agent-worker-pool.ts";

describe("what a turn looks like while it runs", () => {
  it("gives a stalled MCP call its own threshold", () => {
    assert.equal(MCP_EXEC_STALL_THRESHOLD_MS, 900_000);
    assert.equal(typeof createTurnObservation, "function");
  });
});

describe("what a turn looks like while it runs", () => {
  const world = (overrides: Record<string, unknown> = {}) => {
    let epochMs = 1_000_000
    let perfMs = 5_000
    const events: unknown[] = []
    const observation = createTurnObservation({
      now: () => epochMs,
      performanceNow: () => perfMs,
      onEvent: (event: unknown) => events.push(event),
      getConversationId: () => "agent-1",
      ...overrides,
    } as never)
    return { observation, events, advance: (epoch: number, perf = 0) => { epochMs += epoch; perfMs += perf } }
  }
  const fakeExpiry = (arms: { id: string; onExpire: () => void; disposed: boolean }[]) => ({
    arm: (id: string, onExpire: () => void) => {
      const arm = { id, onExpire, disposed: false }
      arms.push(arm)
      return { dispose: () => { arm.disposed = true } }
    },
  })

  it("gives a stalled MCP call its own threshold", () => {
    assert.equal(MCP_EXEC_STALL_THRESHOLD_MS, 900_000)
    assert.equal(typeof createTurnObservation, "function")
  })

  it("keeps the turn's recent activity, and only what changed", () => {
    const { observation, events, advance } = world()
    observation.turnStarted()
    advance(120)
    observation.toolStarted("Read")
    observation.toolCompleted("Read")
    observation.toolCompleted("Read", true)
    assert.deepEqual(observation.snapshot(), { lastTool: undefined, elapsedMs: 120 })
    assert.deepEqual(observation.getActivitySnapshot(), ["[pending] Read", "[done] Read", "[failed] Read"])
    assert.equal(observation.getObservedToolCallCount(), 2)
    assert.deepEqual(events.map((event) => (event as { type: string }).type), ["turn-started", "tool-started", "tool-completed", "tool-completed"])
    // A repeat of the last line is not pushed again, and a summary rides along when it says something.
    observation.recordToolActivity({ status: "done", name: "Read" })
    observation.recordToolActivity({ status: "failed", name: "Read", summary: "" })
    observation.recordToolActivity({ status: "failed", name: "Read", summary: "why" })
    assert.deepEqual(observation.getActivitySnapshot().slice(-2), ["[failed] Read", "[failed] Read: why"])
    // But the same line as the last one is not recorded twice.
    const beforeRepeat = observation.getActivitySnapshot().length
    observation.recordToolActivity({ status: "failed", name: "Read", summary: "why" })
    assert.equal(observation.getActivitySnapshot().length, beforeRepeat)
    // The snapshot is bounded: only the most recent lines are kept.
    for (let index = 0; index < 40; index += 1) observation.recordToolActivity({ status: "done", name: "C" + index })
    assert.equal(observation.getActivitySnapshot().length, 24)
    assert.equal(observation.getActivitySnapshot().at(-1), "[done] C39")
    // A tool that is not the one running is not cleared by another tool finishing.
    observation.toolStarted("A")
    observation.toolCompleted("B")
    assert.equal(observation.snapshot().lastTool, "A")
  })

  it("answers an await with the moment it started, the block it waits for and how it ended", () => {
    const { observation } = world({ isActiveRunCanceled: () => true, isActiveRunInterrupted: () => true })
    const seen: Record<string, unknown>[] = []
    observation.setTurnAwaitHandler((event) => seen.push(event as Record<string, unknown>))
    observation.observeAwaitToolCall("toolCallStarted", "c1", { blockUntilMs: 50 })
    observation.observeAwaitToolCall("toolCallCompleted", "c1", { result: "completed" })
    observation.observeAwaitToolCall("toolCallCompleted", "never-started", { blockUntilMs: -9 })
    observation.observeAwaitToolCall("toolCallStarted", "c2", { blockUntilMs: 7 })
    observation.observeAwaitToolCall("toolCallCompleted", "c2", { result: "timeout" })
    assert.deepEqual(seen, [
      { awaitIndex: 1, blockUntilMs: 50, outcome: "aborted" },
      { awaitIndex: 2, blockUntilMs: 0, outcome: "aborted" },
      { awaitIndex: 3, blockUntilMs: 7, outcome: "aborted" },
    ])
    // Unwinding reports the awaits still pending once, and starts the count over again.
    observation.observeAwaitToolCall("toolCallStarted", "c3", { blockUntilMs: 9 })
    observation.flushPendingAwaitsOnUnwind()
    observation.observeAwaitToolCall("toolCallCompleted", "after-flush", {})
    assert.deepEqual(seen.slice(3), [
      { awaitIndex: 4, blockUntilMs: 9, outcome: "aborted" },
      { awaitIndex: 1, blockUntilMs: 0, outcome: "aborted" },
    ])
  })

  it("says how an await ended when it is not cancelled, and keeps no awaits without a handler", () => {
    const { observation } = world({ isActiveRunCanceled: () => false, isActiveRunInterrupted: () => true })
    const seen: unknown[] = []
    observation.setTurnAwaitHandler((event) => seen.push(event))
    observation.observeAwaitToolCall("toolCallStarted", "c1", { blockUntilMs: 5 })
    observation.observeAwaitToolCall("toolCallCompleted", "c1", { result: "timeout" })
    observation.flushPendingAwaitsOnUnwind()
    assert.deepEqual(seen, [{ awaitIndex: 1, blockUntilMs: 5, outcome: "timeout" }])
    assert.equal(observation.cancelledAwaitOutcome(), "aborted")
    const { observation: silent } = world()
    silent.observeAwaitToolCall("toolCallStarted", "c1", { blockUntilMs: 1 })
    silent.flushPendingAwaitsOnUnwind()
    assert.equal(silent.cancelledAwaitOutcome(), "clean_stop")
  })

  it("reports an MCP call that stalls or fails, once", () => {
    const arms: { id: string; onExpire: () => void; disposed: boolean }[] = []
    let epochMs = 1_000_000
    let perfMs = 5_000
    const observation = createTurnObservation({
      now: () => epochMs,
      performanceNow: () => perfMs,
      getConversationId: () => "agent-1",
    } as never, { mcpExecStallExpiry: fakeExpiry(arms) as never })
    const advance = (epoch: number, perf = 0) => { epochMs += epoch; perfMs += perf }
    const seen: unknown[] = []
    observation.setToolCallDiagnosticHandler((event) => seen.push(event))
    const settled = observation.beginMcpExecObservation({ toolCallId: "call-1", connector: "github", requestId: "req-1" })
    advance(0, 250)
    arms[0]?.onExpire()
    settled("rate-limit")
    settled("again")
    assert.deepEqual(seen.map((event) => (event as { kind: string }).kind), ["stalled", "error"])
    assert.equal((seen[0] as { elapsedMs: number }).elapsedMs, 250)
    assert.equal((seen[1] as { durationMs: number }).durationMs, 250)
    assert.equal((seen[1] as { errorClass: string }).errorClass, "rate-limit")
    assert.equal((seen[0] as { requestId?: string }).requestId, "req-1")
    assert.equal(arms[0]?.disposed, true)
    // A call that ends cleanly says nothing at all.
    const quiet: unknown[] = []
    observation.setToolCallDiagnosticHandler((event) => quiet.push(event))
    observation.beginMcpExecObservation({ toolCallId: "call-2", connector: "github" })()
    assert.deepEqual(quiet, [])
    // A diagnostic without a request id does not carry the key.
    const quietStart = observation.beginMcpExecObservation({ toolCallId: "call-3", connector: "github" })
    advance(0, 1)
    quietStart("boom")
    assert.equal("requestId" in (quiet[0] as unknown as Record<string, unknown>), false)
  })

  it("observes the dispatch and the first token, and names the model the moment it is known", () => {
    const { observation, advance } = world()
    const attributes: [string, unknown][] = []
    const runEvents: [string, unknown][] = []
    const seen: unknown[] = []
    observation.setSendDispatchHandler((event) => seen.push(event))
    observation.setFirstTokenHandler((event) => seen.push(event))
    const arm = observation.armDispatchObservation({
      hostReceiptPerfMs: 5_000,
      enterEpochMs: 999_000,
      conversationId: "agent-1",
      traceId: "trace-1",
      spanId: "span-1",
      isFork: false,
      resolveModelId: () => "model-1",
      setRunAttribute: (key, value) => attributes.push([key, value]),
      addRunEvent: (name, value) => runEvents.push([name, value]),
    })
    // The clock moves 5ms of performance time and one second of epoch time between entering and dispatching.
    advance(1_000, -5)
    assert.deepEqual(attributes, [["slate.send_dispatch_ms", 1_000], ["slate.send_dispatch_host_ms", 0]])
    assert.deepEqual(runEvents, [])
    advance(0, 12)
    arm.observeFirstToken("text")
    arm.observeFirstToken("thinking")
    arm.noteModelResolved("model-2")
    arm.settle()
    assert.deepEqual(attributes.slice(2), [["slate.ttft_ms", 7]])
    assert.deepEqual(runEvents, [["first_token", { chunk_type: "text" }]])
    assert.deepEqual(seen, [
      { dispatchMs: 1_000, hostDispatchMs: 0, skew: false, skewReason: undefined, skewBucket: undefined, isFork: false, modelId: "model-1", traceId: "trace-1", spanId: "span-1" },
      { chunkType: "text", isFork: false, modelId: "model-2", ttftMs: 7, skew: false, skewReason: undefined, traceId: "trace-1", spanId: "span-1" },
    ])
  })

  it("does not observe a dispatch entered from a clock it cannot compare, and settles a first token with no model", () => {
    const { observation } = world()
    const attributes: [string, unknown][] = []
    const seen: unknown[] = []
    observation.setFirstTokenHandler((event) => seen.push(event))
    const notFinite = observation.armDispatchObservation({
      hostReceiptPerfMs: 5_000,
      enterEpochMs: Number.NaN,
      conversationId: "agent-1",
      traceId: "t",
      spanId: "s",
      isFork: true,
      resolveModelId: () => "model-1",
      setRunAttribute: (key, value) => attributes.push([key, value]),
      addRunEvent: () => {},
    })
    notFinite.observeFirstToken("text")
    notFinite.settle()
    assert.deepEqual(attributes, [["slate.ttft_ms", 0]])
    assert.equal((seen[0] as { modelId?: string; isFork?: boolean }).modelId, "model-1")
    assert.equal((seen[0] as { isFork?: boolean }).isFork, true)
  })

  it("lists the running subagent, shell and cloud tasks oldest first", () => {
    const { observation } = world({
      subagentRegistryEntries: () => [
        ["s1", { status: "running", title: "One", startedAtMs: 200, subagentType: "generalPurpose" }],
        ["s2", { status: "running", title: "Aborting", startedAtMs: 100, subagentType: "computerUse" }],
        ["s3", { status: "done", title: "Done", startedAtMs: 50, subagentType: "x" }],
      ],
      isSubagentAborting: (id: string) => id === "s2",
      listBackgroundShellWork: () => [
        { id: "w1", state: "running", metadata: { title: "Background", startTimeMs: 30 } },
        { id: "w2", state: "running", metadata: [1, 2] },
        { id: "w3", state: "stopped", metadata: null },
      ],
      shellRewatchEntries: () => [["w1", { title: "Rewatch registered", startedAtMs: 10 }], ["w9", { title: "Rewatch", startedAtMs: 40 }]],
      cloudAgentWatchEntries: () => [["bc1", { title: "Cloud", startedAtMs: 20 }]],
    })
    assert.deepEqual(observation.listAsyncTasks(), [
      { kind: "shell", id: "w1", label: "Background", status: "running", startedAtMs: 0 },
      { kind: "shell", id: "w2", label: "Background command w2", status: "running", startedAtMs: 0 },
      { kind: "cloud-agent", id: "bc1", label: "Cloud", status: "running", startedAtMs: 20 },
      { kind: "shell", id: "w9", label: "Rewatch", status: "running", startedAtMs: 40, detail: "reattached after a host restart" },
      { kind: "subagent", id: "s1", label: "One", status: "running", startedAtMs: 200, detail: "generalPurpose", subagentType: "generalPurpose" },
    ])
    const seen: unknown[] = []
    observation.setAsyncTasksEventHandler((event) => seen.push(event))
    observation.emitAsyncTasksChanged()
    assert.deepEqual((seen[0] as { parentAgentId: string }).parentAgentId, "agent-1")
    assert.equal((seen[0] as { tasks: unknown[] }).tasks.length, 5)
  })

  it("refuses to emit tasks for an owner it cannot name", () => {
    const { observation } = world({ getConversationId: () => "" })
    assert.throws(() => observation.emitAsyncTasksChanged(), (error: unknown) => error instanceof TypeError && error.message === "async-task owner conversation id is unavailable")
  })
});

describe("running a subagent", () => {
  it("is created with its own conversation, and its work is named", () => {
    assert.equal(typeof createSubagentRuntime, "function");
    assert.equal(typeof computeSubagentRequestId, "function");
    assert.equal(typeof subagentSteerRunOptions, "function");
  });
});

describe("the pool agents' work runs in", () => {
  it("bounds how many workers run, how long they idle and what a line may carry", () => {
    assert.equal(DEFAULT_MAX_WORKERS, 64);
    assert.equal(DEFAULT_IDLE_TIMEOUT_MS, 300_000);
    assert.equal(DEFAULT_SWEEP_INTERVAL_MS, 30_000);
    assert.equal(MAX_FORWARDED_WORKER_LINE_BYTES, 8_192);
    assert.equal(typeof AgentWorkerPool, "function");
    assert.equal(typeof AgentWorkerConnection, "function");
  });
});
