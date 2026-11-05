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
  /** A runtime over a scripted host, with every event it reports kept for the assertions. */
  const world = (overrides: Record<string, unknown> = {}) => {
    let clock = 1_000;
    const events = {
      logs: [] as string[],
      armed: [] as unknown[],
      disarmed: [] as unknown[],
      usage: [] as unknown[],
      audits: [] as unknown[],
      dispatched: [] as unknown[],
      settled: [] as unknown[],
      changed: [] as unknown[],
      freed: [] as string[],
    };
    const host = {
      getConversationId: () => "agent-1",
      resolveBoxId: () => "box-1",
      emitAsyncTasksChanged: () => {},
      computerUse: { freeWindow: (id: string) => events.freed.push(id) },
      now: () => clock,
      log: (message: string) => events.logs.push(message),
      onPendingWakeArmed: (event: unknown) => events.armed.push(event),
      onPendingWakeDisarmed: (event: unknown) => events.disarmed.push(event),
      onComputerUseUsage: (event: unknown) => events.usage.push(event),
      actionAuditor: { record: (record: unknown) => events.audits.push(record) },
      isComputerUseSubagentType: (type: string) => type === "computerUse",
      ...overrides,
    }
    const runtime = createSubagentRuntime(host as never)
    runtime.setBackgroundSubagentDispatchHandler((event) => events.dispatched.push(event))
    runtime.setBackgroundSubagentHandler((event) => events.settled.push(event))
    runtime.setSubagentEventHandler((event) => events.changed.push(event))
    return { runtime, events, advance: (ms: number) => { clock += ms } }
  }
  const sessionOf = (script: Record<string, unknown>) => {
    const calls: { prompt: string; options?: unknown }[] = []
    const interrupts: string[] = []
    return {
      calls,
      session: {
        run: async (prompt: string, options?: unknown) => {
          calls.push({ prompt, options })
          return script.run === undefined ? { text: " done text ", aborted: false } : (script.run as () => unknown)()
        },
        interrupt: (reason: string) => { interrupts.push(reason) },
        getResolvedOutline: async () => {
          if (script.outlineThrows === true) throw new Error("no outline")
          return (script.outline as unknown[]) ?? []
        },
        getObservedToolCallCount: () => (script.toolCallCount as number | undefined) ?? 0,
        getActivitySnapshot: () => (script.activity as string[] | undefined) ?? [],
        getTranscriptPath: () => (script.transcriptPath as string | null | undefined) ?? null,
        ...(script.usage === undefined ? {} : { getComputerUseUsageSnapshot: () => script.usage }),
        ...(script.audit === undefined ? {} : { getComputerUseAuditActionCounts: () => new Map(Object.entries(script.audit as Record<string, number>)) }),
      },
      interrupts,
    }
  }
  const settle = async (runtime: ReturnType<typeof world>["runtime"]) => {
    await runtime.drainBackgroundSubagents()
    await new Promise((resolve) => setTimeout(resolve, 0))
  }

  it("names a subagent's requests after its tool call, and steers it with the parent's lineage", () => {
    assert.equal(computeSubagentRequestId("call-1"), "subagent:call-1");
    assert.equal(computeSubagentRequestId(""), "subagent");
    assert.deepEqual(subagentSteerRunOptions({ toolCallId: "call-1" }), { inferenceRequestId: "subagent:call-1" });
    assert.deepEqual(subagentSteerRunOptions({ toolCallId: "", lineage: { parentRequestId: "p" } }), { inferenceRequestId: "subagent", lineage: { parentRequestId: "p" } });
    assert.deepEqual(subagentSteerRunOptions({ toolCallId: "call-2", lineage: { parentAgentToolCallId: "old", parentRequestId: "p" } }), { inferenceRequestId: "subagent:call-2", lineage: { parentAgentToolCallId: "call-2", parentRequestId: "p" } });
  })

  it("dispatches, settles and reports one background subagent", async () => {
    const { runtime, events, advance } = world()
    const scripted = sessionOf({ outline: [{ a: 1 }], toolCallCount: 3, activity: ["[done] Read"], transcriptPath: "/t/1" })
    runtime.sessions.set("sub-1", scripted.session as never)
    runtime.dispatchBackgroundSubagent({ subagentAgentId: "sub-1", subagentType: "generalPurpose", toolCallId: "call-1", prompt: "do the thing", quietOrigin: "wake", run: () => scripted.session.run("do the thing") as never })
    assert.equal(runtime.hasRunningSubagents(), true)
    assert.equal(runtime.hasRunningToolCall("call-1"), true)
    assert.equal(runtime.hasRunningToolCall("other-call"), false)
    // The duplicate dispatch of a running subagent is ignored, and it is listed while it runs.
    runtime.dispatchBackgroundSubagent({ subagentAgentId: "sub-1", subagentType: "generalPurpose", toolCallId: "call-1", prompt: "again", run: () => scripted.session.run("again") as never })
    assert.equal(runtime.getRunningSubagent("sub-1")?.title, "do the thing")
    assert.equal(runtime.listRunningSubagents().length, 1)
    advance(500)
    await settle(runtime)
    assert.deepEqual(events.logs, ['[slate][subagent] dispatched sub-1 [generalPurpose] "do the thing"', '[slate][subagent] settled sub-1 [generalPurpose] "do the thing" status=done'])
    assert.deepEqual(events.dispatched, [{ parentAgentId: "agent-1", subagentAgentId: "sub-1", subagentType: "generalPurpose", toolCallId: "call-1", subagentRequestId: "subagent:call-1" }])
    assert.deepEqual(events.armed, [{ parentAgentId: "agent-1", kind: "subagent", workId: "sub-1", title: "do the thing", subagentType: "generalPurpose", quietOrigin: "wake" }])
    assert.deepEqual(events.settled, [{ parentAgentId: "agent-1", subagentAgentId: "sub-1", subagentType: "generalPurpose", toolCallId: "call-1", title: "do the thing", status: "completed", result: "done text", quietOrigin: "wake" }])
    assert.equal(runtime.isRunning("sub-1"), false)
    assert.equal(runtime.hasRunningSubagents(), false)
    // While it was running it was counted as running, and its title came from the prompt.
    assert.equal(runtime.listSubagents()[0]?.startedAtMs, 1_000)
    assert.deepEqual(events.freed, ["sub-1"])
    assert.deepEqual(await runtime.getSubagentOutline("sub-1"), [{ a: 1 }])
    assert.equal(runtime.listSubagents()[0]?.status, "done")
    assert.equal(runtime.hasRunningToolCall("call-1"), false)
  })

  it("settles a run that throws or rejects as an error", async () => {
    const sync = world()
    sync.runtime.dispatchBackgroundSubagent({ subagentAgentId: "sync", subagentType: "generalPurpose", toolCallId: "c", prompt: "x", run: () => { throw new Error("sync boom") } })
    await settle(sync.runtime)
    assert.equal((sync.events.settled[0] as { result?: string } | undefined)?.result, "sync boom")
    // A run with no quiet origin does not carry the field at all.
    assert.equal("quietOrigin" in (sync.events.settled[0] as object), false)
    assert.equal((sync.events.settled[0] as { status?: string } | undefined)?.status, "error")
    const rejected = world()
    rejected.runtime.dispatchBackgroundSubagent({ subagentAgentId: "rejected", subagentType: "generalPurpose", toolCallId: "c", prompt: "x", run: () => Promise.reject("string boom") })
    await settle(rejected.runtime)
    assert.equal((rejected.events.settled[0] as { result?: string } | undefined)?.result, "string boom")
  })

  it("reports a run that aborted itself as aborted, and a quiet one as producing no text", async () => {
    const aborted = world()
    aborted.runtime.sessions.set("sub-1", sessionOf({ run: () => ({ text: "ignored", aborted: true }) }).session as never)
    aborted.runtime.dispatchBackgroundSubagent({ subagentAgentId: "sub-1", subagentType: "generalPurpose", toolCallId: "c", prompt: "x", run: () => aborted.runtime.sessions.get("sub-1")!.run("x") as never })
    await settle(aborted.runtime)
    assert.equal(aborted.runtime.listSubagents()[0]?.status, "aborted")
    assert.equal((aborted.events.settled[0] as { result?: string } | undefined)?.result, "The background task was interrupted before it finished.")
    const quiet = world()
    quiet.runtime.sessions.set("sub-1", sessionOf({ run: () => ({ text: "   ", aborted: false }) }).session as never)
    quiet.runtime.dispatchBackgroundSubagent({ subagentAgentId: "sub-1", subagentType: "generalPurpose", toolCallId: "c", prompt: "x", run: () => quiet.runtime.sessions.get("sub-1")!.run("x") as never })
    await settle(quiet.runtime)
    assert.equal((quiet.events.settled[0] as { result?: string } | undefined)?.result, "(the task finished without producing any text output)")
  })

  it("steers a running subagent into another turn, and refuses to steer one that is not running", async () => {
    const { runtime } = world()
    let release: (value: unknown) => void = () => {}
    const first = new Promise((resolve) => { release = resolve })
    const scripted = sessionOf({ run: () => first })
    runtime.sessions.set("sub-1", scripted.session as never)
    runtime.dispatchBackgroundSubagent({ subagentAgentId: "sub-1", subagentType: "generalPurpose", toolCallId: "c", prompt: "x", run: () => scripted.session.run("x") as never })
    assert.equal(runtime.steerSubagent("sub-1", "please hurry"), "ok")
    assert.deepEqual(scripted.interrupts, ["Steering message from the parent agent."])
    release({ text: "first", aborted: false })
    await settle(runtime)
    await settle(runtime)
    assert.equal(scripted.calls.length, 2)
    assert.equal(String(scripted.calls[1]?.prompt).includes("please hurry"), true)
    // The steering message is wrapped: it is not passed through as the user's words.
    assert.notEqual(scripted.calls[1]?.prompt, "please hurry")
    // A session that exists without a run behind it cannot be steered.
    runtime.sessions.set("idle", scripted.session as never)
    assert.equal(runtime.steerSubagent("idle", "hello"), "not-running")
    assert.equal(runtime.steerSubagent("missing", "no"), "not-running")
  })

  it("stops a running subagent, disarms its wake and refuses to steer it afterwards", async () => {
    const { runtime, events } = world()
    let release: (value: unknown) => void = () => {}
    const pending = new Promise((resolve) => { release = resolve })
    const scripted = sessionOf({ run: () => pending })
    runtime.sessions.set("sub-1", scripted.session as never)
    runtime.dispatchBackgroundSubagent({ subagentAgentId: "sub-1", subagentType: "generalPurpose", toolCallId: "c", prompt: "x", run: () => scripted.session.run("x") as never })
    assert.equal(runtime.abortSubagent("sub-1"), "ok")
    assert.equal(runtime.abortSubagent("sub-1"), "ok")
    assert.equal(runtime.steerSubagent("sub-1", "too late"), "not-running")
    release({ text: "late", aborted: false })
    await settle(runtime)
    assert.deepEqual(scripted.interrupts.slice(-1), ["Stopped by the parent agent."])
    // Each abort of the still-running subagent disarms its wake, and the settle after the abort does too.
    assert.equal(events.disarmed.length, 3)
    assert.deepEqual(events.disarmed[0], { parentAgentId: "agent-1", kind: "subagent", workId: "sub-1" })
    assert.equal(runtime.listSubagents()[0]?.status, "aborted")
    assert.deepEqual(events.settled, [])
  })

  it("lists subagents oldest first", async () => {
    const { runtime, advance } = world()
    const first = sessionOf({})
    const second = sessionOf({})
    runtime.sessions.set("b", first.session as never)
    runtime.sessions.set("a", second.session as never)
    runtime.dispatchBackgroundSubagent({ subagentAgentId: "b", subagentType: "generalPurpose", toolCallId: "cb", prompt: "b", run: () => first.session.run("b") as never })
    advance(10)
    runtime.dispatchBackgroundSubagent({ subagentAgentId: "a", subagentType: "generalPurpose", toolCallId: "ca", prompt: "a", run: () => second.session.run("a") as never })
    assert.deepEqual(runtime.listSubagents().map((entry) => entry.subagentId), ["b", "a"])
    await settle(runtime)
  })

  it("accounts for a computerUse run's spend and audit", async () => {
    const { runtime, events, advance } = world()
    const session = sessionOf({ usage: { modelId: "m-1", turnEndedCount: 2, usage: { tokens: 9 } }, toolCallCount: 4, audit: { screenshot: 2, click: 3 } }).session as never
    runtime.sessions.set("sub-1", session)
    runtime.dispatchBackgroundSubagent({ subagentAgentId: "sub-1", subagentType: "computerUse", toolCallId: "call-1", prompt: "x", run: () => (session as { run: (p: string) => Promise<unknown> }).run("x") as never })
    advance(250)
    await settle(runtime)
    assert.deepEqual(events.usage, [{ parentAgentId: "agent-1", subagentAgentId: "sub-1", subagentType: "computerUse", subagentRequestId: "subagent:call-1", modelId: "m-1", outcome: "completed", durationMs: 250, toolCallCount: 4, turnEndedCount: 2, usage: { tokens: 9 } }])
    assert.deepEqual((events.audits[0] as { action: unknown }).action, { kind: "computerUseSession", toolCallId: "call-1", actionCount: 5, actionCounts: { screenshot: 2, click: 3 }, durationMs: 250, screenshotCount: 2 })
    assert.equal((events.audits[0] as unknown as { turnId: string }).turnId, "subagent:call-1")
  })

  it("resets its registry, forwards settled work, and answers outlines after a run", async () => {
    const { runtime, events } = world()
    runtime.notifyBackgroundWorkSettled({ parentAgentId: "agent-1", subagentAgentId: "sub-2", subagentType: "generalPurpose", toolCallId: "c2", title: "T", status: "completed", result: "ok" })
    assert.equal(events.settled.length, 1)
    const failing = sessionOf({ outlineThrows: true })
    runtime.sessions.set("sub-1", failing.session as never)
    runtime.dispatchBackgroundSubagent({ subagentAgentId: "sub-1", subagentType: "generalPurpose", toolCallId: "c", prompt: "x", run: () => failing.session.run("x") as never })
    await settle(runtime)
    assert.deepEqual(await runtime.getSubagentOutline("sub-1"), [])
    assert.deepEqual(await runtime.getSubagentOutline("missing"), [])
    runtime.reset()
    assert.equal(runtime.hasSubagent("sub-1"), false)
    assert.equal(runtime.listSubagents().length, 0)
    assert.equal(runtime.hasRunningSubagents(), false)
  })
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
