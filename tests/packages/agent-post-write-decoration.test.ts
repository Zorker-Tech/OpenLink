import { test } from "node:test"
import assert from "node:assert/strict"

import { decoratePostWriteResultForModel } from "../../source/packages/agent/tools/core/edit/post-write-result-decoration.ts"
import { createContext, type Context } from "../../source/packages/context/context.ts"
import { configOverridesKey } from "../../source/packages/agent/utils/config-overrides.ts"
import { loggerKey } from "../../source/packages/context/logging.ts"
import { metricsKey } from "../../source/packages/metrics/index.ts"
import { conversationIdKey } from "../../source/packages/agent/utils/request-scope.ts"
import { canvasDiagnosticsExecutorResource } from "../../source/packages/agent-exec/canvas-diagnostics.ts"
import { agentStoreConflictNoticeExecutorResource } from "../../source/packages/agent-exec/agent-store-conflict-notice.ts"
import {
  CanvasDiagnosticsResult,
  CanvasDiagnosticsSuccess,
} from "../../source/packages/proto/generated/agent/v1/canvas_diagnostics_exec_pb.ts"
import { Diagnostic, DiagnosticSeverity } from "../../source/packages/proto/generated/agent/v1/diagnostics_exec_pb.ts"

// ---------------------------------------------------------------------------------------------
// a write's result, decorated by the two things that happen after a save
// ---------------------------------------------------------------------------------------------

const CANVAS_PATH = "/repo/.slate/projects/workspace-1/canvases/dashboard.canvas.tsx"

interface Harness {
  readonly conflictCalls: Array<{ op: string; args: Record<string, unknown> }>
  readonly accessor: unknown
}

function harness(options: {
  diagnostics?: unknown
  diagnosticsThrows?: boolean
  diagnosticsHang?: number
  conflictAnswers?: Record<string, unknown>
  conflictThrows?: boolean
  conflictThrowsOps?: string[]
  conflictHandlers?: Record<string, (ctx: unknown, args: Record<string, unknown>) => unknown>
  noCanvasExecutor?: boolean
  noConflictExecutor?: boolean
  accessorThrows?: boolean
} = {}): Harness {
  const conflictCalls: Harness["conflictCalls"] = []
  const canvasExecutor = {
    async execute() {
      if (options.diagnosticsThrows === true) throw new Error("the workspace is gone")
      if (options.diagnosticsHang !== undefined) await new Promise((resolve) => setTimeout(resolve, options.diagnosticsHang))
      return options.diagnostics ?? new CanvasDiagnosticsResult({
        result: { case: "success", value: new CanvasDiagnosticsSuccess({ path: CANVAS_PATH, diagnostics: [] }) },
      })
    },
  }
  const conflictExecutor = {
    async execute(ctx: unknown, args: Record<string, unknown>) {
      conflictCalls.push({ op: String(args.op), args })
      if (options.conflictThrows === true) throw new Error("the store is gone")
      if (options.conflictThrowsOps?.includes(String(args.op)) === true) throw new Error("the " + String(args.op) + " failed")
      const handler = options.conflictHandlers?.[String(args.op)]
      if (handler !== undefined) return handler(ctx, args)
      return (options.conflictAnswers ?? {})[String(args.op)] ?? { kind: "not-applicable", events: [] }
    },
  }
  return {
    conflictCalls,
    accessor: {
      get: (resource: unknown) => {
        if (options.accessorThrows === true) throw new Error("the accessor is gone")
        if (resource === canvasDiagnosticsExecutorResource) return options.noCanvasExecutor === true ? undefined : canvasExecutor
        if (resource === agentStoreConflictNoticeExecutorResource) return options.noConflictExecutor === true ? undefined : conflictExecutor
        return undefined
      },
    },
  }
}

const decorate = (
  harnessed: Harness,
  options: {
    path?: string
    result?: string
    ctx?: Context
    decoration?: Record<string, unknown>
  } = {},
) => decoratePostWriteResultForModel(
  options.ctx ?? createContext().with(conversationIdKey, "conversation-1"),
  harnessed.accessor as never,
  options.path ?? "/repo/src/app.ts",
  options.result ?? "the file was written",
  "call-1",
  options.decoration as never,
)

const diagnosticsOf = (diagnostics: Diagnostic[]): CanvasDiagnosticsResult =>
  new CanvasDiagnosticsResult({
    result: { case: "success", value: new CanvasDiagnosticsSuccess({ path: CANVAS_PATH, diagnostics }) },
  })

const diagnostic = (severity: number, message: string, line = 1, column = 1, source?: string): Diagnostic =>
  new Diagnostic({
    severity: severity as never,
    message,
    ...(source === undefined ? {} : { source }),
    range: { start: { line, column, character: 0 } } as never,
  })

// ---------------------------------------------------------------------------------------------
// diagnostics for a canvas
// ---------------------------------------------------------------------------------------------

test("a write to anything but a canvas is left as it is", async () => {
  const harnessed = harness()
  assert.equal(await decorate(harnessed, { path: "/repo/src/app.ts" }), "the file was written")
})

test("a canvas with nothing wrong says so", async () => {
  const harnessed = harness()
  const result = await decorate(harnessed, { path: CANVAS_PATH })
  assert.match(result, /^the file was written\n\nCanvas TypeScript check: no errors\.$/)
})

test("a canvas's errors and warnings are appended with their positions", async () => {
  const harnessed = harness({
    diagnostics: diagnosticsOf([
      diagnostic(DiagnosticSeverity.ERROR, "Cannot find name 'x'", 12, 3, "ts"),
      diagnostic(DiagnosticSeverity.WARNING, "Unused variable", 20, 7),
      // An informational diagnostic is not worth telling the model about.
      diagnostic(DiagnosticSeverity.UNSPECIFIED, "Just so you know", 30, 1),
    ]),
  })
  const result = await decorate(harnessed, { path: CANVAS_PATH })
  assert.match(result, /Canvas TypeScript check: 2 issues in .*dashboard\.canvas\.tsx:/)
  assert.match(result, /\[ERROR\] L12:3 - Cannot find name 'x' \(ts\)/)
  assert.match(result, /\[WARNING\] L20:7 - Unused variable/)
  assert.doesNotMatch(result, /Just so you know/)
})

test("one issue is described in the singular", async () => {
  const harnessed = harness({ diagnostics: diagnosticsOf([diagnostic(DiagnosticSeverity.ERROR, "one problem")]) })
  assert.match(await decorate(harnessed, { path: CANVAS_PATH }), /1 issue in /)
})

test("a check that failed or timed out leaves the result alone", async () => {
  const failed = harness({ diagnostics: new CanvasDiagnosticsResult({ result: { case: "error", value: { error: "no" } as never } }) })
  assert.equal(await decorate(failed, { path: CANVAS_PATH }), "the file was written")

  const thrown = harness({ diagnosticsThrows: true })
  assert.equal(await decorate(thrown, { path: CANVAS_PATH }), "the file was written")
})

test("a session with no way to run the check still reports the write", async () => {
  const harnessed = harness({ noCanvasExecutor: true })
  assert.equal(await decorate(harnessed, { path: CANVAS_PATH }), "the file was written")
})

// ---------------------------------------------------------------------------------------------
// the store conflict barrier
// ---------------------------------------------------------------------------------------------

const withNotices = { enableAgentStoreConflictNotices: true }

test("conflict notices are only looked for where the session asked for them", async () => {
  const harnessed = harness()
  await decorate(harnessed, { path: "/repo/src/app.ts" })
  assert.deepEqual(harnessed.conflictCalls, [])
})

test("a conflict the store caught up with is appended and acknowledged", async () => {
  const harnessed = harness({
    conflictAnswers: {
      syncAndPeek: { kind: "completed", events: [{ eventId: "event-1" }], reminder: "another agent changed this file" },
      ack: { kind: "acked", count: 1 },
    },
  })
  const result = await decorate(harnessed, { path: "/repo/src/app.ts", decoration: withNotices })
  assert.match(result, /^the file was written\n\nanother agent changed this file$/)
  assert.deepEqual(harnessed.conflictCalls.map(call => call.op), ["syncAndPeek", "ack"])
  assert.deepEqual(harnessed.conflictCalls[1]?.args.eventIds, ["event-1"])
  // The write is announced before the wait, so a conflict can be attributed to it.
  assert.deepEqual(harnessed.conflictCalls[0]?.args.writtenPaths, ["/repo/src/app.ts"])
  assert.equal(harnessed.conflictCalls[0]?.args.eager, true)
  assert.equal(harnessed.conflictCalls[0]?.args.conversationId, "conversation-1")
  // The wait is the barrier's own default when the session names no deadline.
  assert.equal(harnessed.conflictCalls[0]?.args.timeoutMs, 2_000)
})

test("a store that caught up with nothing leaves the result alone", async () => {
  const harnessed = harness({ conflictAnswers: { syncAndPeek: { kind: "completed", events: [] } } })
  assert.equal(await decorate(harnessed, { path: "/repo/src/app.ts", decoration: withNotices }), "the file was written")
})

test("a store that is not shared, or mounted passively, falls back to the journal", async () => {
  for (const kind of ["not-applicable", "mount-passive"]) {
    const harnessed = harness({
      conflictAnswers: { syncAndPeek: { kind, events: [] }, peek: { kind: "completed", events: [], reminder: "from the journal" } },
    })
    const result = await decorate(harnessed, { path: "/repo/src/app.ts", decoration: withNotices })
    // The journal had nothing to attribute, so the reminder is not shown either.
    assert.equal(result, "the file was written", kind)
  }
})

test("a wait that ran out of time still reports the write, with what the journal knows", async () => {
  const harnessed = harness({
    conflictAnswers: {
      syncAndPeek: { kind: "timed-out", events: [{ eventId: "event-1" }], reminder: "a conflict was found late" },
      ack: { kind: "acked", count: 1 },
    },
  })
  const result = await decorate(harnessed, { path: "/repo/src/app.ts", decoration: withNotices })
  assert.match(result, /a conflict was found late/)
  assert.equal(harnessed.conflictCalls.some(call => call.op === "ack"), true)
})

test("a wait that ran out of time with nothing to say leaves the result alone", async () => {
  const harnessed = harness({
    conflictAnswers: { syncAndPeek: { kind: "timed-out", events: [] }, peek: { kind: "timed-out", events: [] } },
  })
  assert.equal(await decorate(harnessed, { path: "/repo/src/app.ts", decoration: withNotices }), "the file was written")
})

test("a barrier that failed is reported as a write rather than an error", async () => {
  const harnessed = harness({ conflictThrows: true })
  assert.equal(await decorate(harnessed, { path: "/repo/src/app.ts", decoration: withNotices }), "the file was written")
})

test("a session with no store to ask reports the write as it is", async () => {
  const harnessed = harness({ noConflictExecutor: true })
  assert.equal(await decorate(harnessed, { path: "/repo/src/app.ts", decoration: withNotices }), "the file was written")
})

test("a barrier that is switched off does not wait at all", async () => {
  const harnessed = harness({
    conflictAnswers: { peek: { kind: "completed", events: [{ eventId: "event-1" }], reminder: "from the journal" }, ack: { kind: "acked", count: 1 } },
  })
  const barrierEvents: Array<{ outcome: string }> = []
  const result = await decorate(harnessed, {
    path: "/repo/src/app.ts",
    decoration: { enableAgentStoreConflictNotices: true, writeBarrierTimeoutMs: 0, onWriteBarrier: (event: { outcome: string }) => barrierEvents.push(event) },
  })
  // With no deadline there is no eager wait; the journal is read once and what it says is shown.
  assert.deepEqual(harnessed.conflictCalls.map(call => call.op), ["peek", "ack"])
  assert.match(result, /from the journal/)
  assert.deepEqual(barrierEvents.map(event => event.outcome), ["skipped"])
})

test("what the barrier did is reported to a caller that asked", async () => {
  const harnessed = harness({
    conflictAnswers: { syncAndPeek: { kind: "completed", events: [{ eventId: "event-1" }], reminder: "a conflict" }, ack: { kind: "acked", count: 1 } },
  })
  const outcomes: string[] = []
  await decorate(harnessed, {
    path: "/repo/src/app.ts",
    decoration: { enableAgentStoreConflictNotices: true, onWriteBarrier: (event: { outcome: string }) => outcomes.push(event.outcome) },
  })
  assert.deepEqual(outcomes, ["synced"])
})

test("a write in a turn that was already interrupted is noted rather than waited for", async () => {
  const controller = new AbortController()
  controller.abort()
  const harnessed = harness({ conflictAnswers: { noteDeferredEagerWrittenPaths: { kind: "noted", count: 1 } } })
  const ctx = createContext().with(conversationIdKey, "conversation-1")
  // The context's own signal is what the barrier watches, so an aborted turn never waits.
  ;(ctx as unknown as { signal: AbortSignal }).signal = controller.signal
  const result = await decorate(harnessed, { path: "/repo/src/app.ts", ctx, decoration: withNotices })
  assert.equal(result, "the file was written")
  assert.deepEqual(harnessed.conflictCalls.map(call => call.op), ["noteDeferredEagerWrittenPaths"])
})

test("a conflict found for a canvas comes after the diagnostics", async () => {
  const harnessed = harness({
    diagnostics: diagnosticsOf([diagnostic(DiagnosticSeverity.ERROR, "a canvas problem")]),
    conflictAnswers: { syncAndPeek: { kind: "completed", events: [{ eventId: "event-1" }], reminder: "a conflict" }, ack: { kind: "acked", count: 1 } },
  })
  const result = await decorate(harnessed, { path: CANVAS_PATH, decoration: withNotices })
  assert.equal(result.includes("a canvas problem"), true)
  assert.equal(result.includes("a conflict"), true)
  assert.equal(result.indexOf("a canvas problem") < result.indexOf("a conflict"), true)
})

// ---------------------------------------------------------------------------------------------
// what the rewrite made explicit: the fallback journal, the interrupted turn and the reported outcomes
// ---------------------------------------------------------------------------------------------

test("a diagnostic without a position or a source reports zeroes and no suffix", async () => {
  const bare = new Diagnostic({ severity: DiagnosticSeverity.ERROR, message: "no position" })
  const harnessed = harness({ diagnostics: diagnosticsOf([bare]) })
  const result = await decorate(harnessed, { path: CANVAS_PATH })
  assert.match(result, /\n  \[ERROR\] L0:0 - no position$/)
})

test("a canvas check that hangs is given up on and the write is reported", async () => {
  const harnessed = harness({ diagnosticsHang: 200 })
  const ctx = createContext().with(conversationIdKey, "conversation-1").with(configOverridesKey, { canvas_post_edit_diagnostics_timeout_ms: 5 })
  assert.equal(await decorate(harnessed, { path: CANVAS_PATH, ctx }), "the file was written")
})

test("a journal that has something to say is drained and acknowledged when the store had nothing", async () => {
  const harnessed = harness({
    conflictAnswers: {
      syncAndPeek: { kind: "not-applicable", events: [] },
      peek: { kind: "completed", events: [{ eventId: "journal-1" }], reminder: "from the journal" },
      ack: { kind: "acked", count: 1 },
    },
  })
  const outcomes: string[] = []
  const result = await decorate(harnessed, {
    path: "/repo/src/app.ts",
    decoration: { enableAgentStoreConflictNotices: true, onWriteBarrier: (event: { outcome: string }) => outcomes.push(event.outcome) },
  })
  assert.match(result, /from the journal/)
  assert.deepEqual(harnessed.conflictCalls.map((call) => call.op), ["syncAndPeek", "peek", "ack"])
  assert.deepEqual(harnessed.conflictCalls[2]?.args.eventIds, ["journal-1"])
  // The barrier reports the kind it saw; the journal drain keeps its own outcome for telemetry.
  assert.deepEqual(outcomes, ["absent"])
})

test("a reminder with no event behind it is shown without acknowledging anything", async () => {
  const harnessed = harness({ conflictAnswers: { syncAndPeek: { kind: "completed", events: [], reminder: "a reminder with no event" } } })
  const result = await decorate(harnessed, { path: "/repo/src/app.ts", decoration: withNotices })
  assert.match(result, /a reminder with no event$/)
  assert.deepEqual(harnessed.conflictCalls.map((call) => call.op), ["syncAndPeek"])
})

test("an acknowledgement that failed still shows the reminder and releases what it holds", async () => {
  const harnessed = harness({
    conflictAnswers: { syncAndPeek: { kind: "completed", events: [{ eventId: "event-1" }], reminder: "a conflict" } },
    conflictThrowsOps: ["ack"],
  })
  const outcomes: string[] = []
  const result = await decorate(harnessed, {
    path: "/repo/src/app.ts",
    decoration: { enableAgentStoreConflictNotices: true, onWriteBarrier: (event: { outcome: string }) => outcomes.push(event.outcome) },
  })
  assert.match(result, /a conflict$/)
  assert.deepEqual(harnessed.conflictCalls.map((call) => call.op), ["syncAndPeek", "ack", "release"])
  assert.deepEqual(outcomes, ["synced"])
})

test("each kind of eager answer is reported under its own outcome", async () => {
  const expectations: Array<[Record<string, unknown>, string]> = [
    [{ kind: "not-applicable", events: [] }, "absent"],
    [{ kind: "mount-passive", events: [] }, "passive"],
    [{ kind: "failed", events: [] }, "error"],
    [{ kind: "timed-out", events: [] }, "timeout"],
    [{ kind: "completed", events: [] }, "synced"],
  ]
  for (const [answer, expected] of expectations) {
    const harnessed = harness({ conflictAnswers: { syncAndPeek: answer, peek: { kind: "completed", events: [] } } })
    const outcomes: string[] = []
    await decorate(harnessed, {
      path: "/repo/src/app.ts",
      decoration: { enableAgentStoreConflictNotices: true, onWriteBarrier: (event: { outcome: string }) => outcomes.push(event.outcome) },
    })
    assert.deepEqual(outcomes, [expected], JSON.stringify(answer))
  }
})

test("a turn interrupted while the store was being asked releases its events and notes the write", async () => {
  const harnessed = harness({
    conflictHandlers: {
      syncAndPeek: (ctx: unknown) => {
        ;(ctx as { signal: AbortSignal }).signal = AbortSignal.abort()
        return { kind: "completed", events: [{ eventId: "event-1" }], reminder: "a conflict" }
      },
    },
  })
  const outcomes: string[] = []
  const result = await decorate(harnessed, {
    path: "/repo/src/app.ts",
    decoration: { enableAgentStoreConflictNotices: true, onWriteBarrier: (event: { outcome: string }) => outcomes.push(event.outcome) },
  })
  assert.equal(result, "the file was written")
  assert.deepEqual(harnessed.conflictCalls.map((call) => call.op), ["syncAndPeek", "release", "noteDeferredEagerWrittenPaths"])
  assert.deepEqual(outcomes, ["synced"])
})

test("a barrier that is switched off drains the journal and reports itself skipped", async () => {
  const harnessed = harness({
    conflictAnswers: {
      peek: { kind: "timed-out", events: [{ eventId: "journal-1" }], reminder: "late from the journal" },
      ack: { kind: "acked", count: 1 },
    },
  })
  const outcomes: string[] = []
  const result = await decorate(harnessed, {
    path: "/repo/src/app.ts",
    decoration: { enableAgentStoreConflictNotices: true, writeBarrierTimeoutMs: 0, onWriteBarrier: (event: { outcome: string }) => outcomes.push(event.outcome) },
  })
  assert.match(result, /late from the journal/)
  assert.deepEqual(outcomes, ["skipped"])
})

test("a session that cannot look anything up reports the write as it is", async () => {
  const harnessed = harness({ accessorThrows: true })
  assert.equal(await decorate(harnessed, { path: CANVAS_PATH }), "the file was written")
  assert.equal(await decorate(harnessed, { path: "/repo/src/app.ts", decoration: withNotices }), "the file was written")
})

test("the conversation a write belongs to travels with every notice operation, and is absent when it is not named", async () => {
  const withConversation = harness({ conflictAnswers: { syncAndPeek: { kind: "completed", events: [{ eventId: "event-1" }], reminder: "a conflict" } } })
  await decorate(withConversation, { path: "/repo/src/app.ts", decoration: withNotices })
  assert.deepEqual(withConversation.conflictCalls.slice(0, 2).map((call) => call.args.conversationId), ["conversation-1", "conversation-1"])

  const withoutConversation = harness({ conflictAnswers: { syncAndPeek: { kind: "completed", events: [{ eventId: "event-1" }], reminder: "a conflict" } } })
  await decorate(withoutConversation, { path: "/repo/src/app.ts", ctx: createContext(), decoration: withNotices })
  assert.deepEqual(withoutConversation.conflictCalls.map((call) => "conversationId" in call.args), [false, false])
})

// ---------------------------------------------------------------------------------------------
// what the barrier counts and writes down
// ---------------------------------------------------------------------------------------------

interface RecordedMetric { readonly name: string; readonly value: number; readonly labels?: Readonly<Record<string, string>> | undefined }
interface RecordedLog { readonly level: string; readonly message: string; readonly metadata?: Readonly<Record<string, unknown>> | undefined }

/** A context whose metrics and logs are recorded rather than reported, and that belongs to a conversation. */
function recordingContext(metrics: RecordedMetric[], logs: RecordedLog[]) {
  return createContext()
    .with(conversationIdKey, "conversation-1")
    .with(metricsKey, {
      record() {},
      increment(_context: Context, handle: { name: string }, value: number, labels?: Record<string, string>) {
        metrics.push({ name: handle.name, value, labels })
      },
      gauge() {},
      histogram() {},
    } as never)
    .with(loggerKey, {
      log(_context: Context, entry: { level: string; message: string; metadata?: Record<string, unknown> }) {
        logs.push({ level: entry.level, message: entry.message, metadata: entry.metadata })
      },
    } as never)
}

test("the barrier counts the outcome it attributed", async () => {
  const cases: Array<[string, Record<string, unknown>, string[]]> = [
    ["attributed", { syncAndPeek: { kind: "completed", events: [{ eventId: "event-1" }], reminder: "a conflict" }, ack: { kind: "acked", count: 1 } }, ["attributed"]],
    ["attributed_timed_out", { syncAndPeek: { kind: "timed-out", events: [{ eventId: "event-1" }], reminder: "a late conflict" }, ack: { kind: "acked", count: 1 } }, ["attributed_timed_out"]],
    ["journal_fallback", { syncAndPeek: { kind: "not-applicable", events: [] }, peek: { kind: "completed", events: [{ eventId: "journal-1" }], reminder: "from the journal" }, ack: { kind: "acked", count: 1 } }, ["journal_fallback"]],
    ["error", { syncAndPeek: { kind: "failed", events: [] }, peek: { kind: "completed", events: [] } }, ["error"]],
    ["timed_out", { syncAndPeek: { kind: "timed-out", events: [] }, peek: { kind: "completed", events: [] } }, ["timed_out"]],
    ["degraded", { syncAndPeek: { kind: "not-applicable", events: [] }, peek: { kind: "completed", events: [] } }, ["degraded"]],
    ["clean", { syncAndPeek: { kind: "completed", events: [] }, peek: { kind: "completed", events: [] } }, ["clean"]],
  ]
  for (const [label, conflictAnswers, expected] of cases) {
    const metrics: RecordedMetric[] = []
    const logs: RecordedLog[] = []
    const harnessed = harness({ conflictAnswers })
    await decorate(harnessed, { path: "/repo/src/app.ts", ctx: recordingContext(metrics, logs), decoration: withNotices })
    assert.deepEqual(metrics.map((metric) => metric.name), ["agent.store.eager_barrier"], label)
    assert.deepEqual(metrics.map((metric) => metric.value), [1], label)
    assert.deepEqual(metrics.map((metric) => metric.labels?.outcome), expected, label)
  }
})

test("the barrier writes down what it attributed and what failed", async () => {
  const recordedLines = async (conflictAnswers: Record<string, unknown>, conflictThrowsOps: string[] = []): Promise<RecordedLog[]> => {
    const metrics: RecordedMetric[] = []
    const logs: RecordedLog[] = []
    const harnessed = harness({ conflictAnswers, conflictThrowsOps })
    await decorate(harnessed, { path: "/repo/src/app.ts", ctx: recordingContext(metrics, logs), decoration: withNotices })
    return logs
  }

  const attributed = await recordedLines({ syncAndPeek: { kind: "completed", events: [{ eventId: "event-1" }], reminder: "a conflict" } })
  assert.deepEqual(attributed.map((log) => [log.level, log.message]), [["info", "Local-sync eager conflict barrier attributed"]])
  assert.deepEqual(attributed[0]?.metadata, { eventCount: 1 })

  // An acknowledgement that failed still leaves the reminder attributable, so the attribution is written too.
  assert.deepEqual(
    (await recordedLines({ syncAndPeek: { kind: "completed", events: [{ eventId: "event-1" }], reminder: "a conflict" } }, ["ack"])).map((log) => [log.level, log.message]),
    [["warn", "Eager store conflict ack failed"], ["info", "Local-sync eager conflict barrier attributed"]],
  )
  assert.deepEqual(
    (await recordedLines({ syncAndPeek: { kind: "failed", events: [] }, peek: { kind: "completed", events: [] } }, ["peek"])).map((log) => [log.level, log.message]),
    [["warn", "Eager store conflict journal-drain fallback failed"]],
  )
  assert.deepEqual(
    (await recordedLines({}, ["syncAndPeek"])).map((log) => [log.level, log.message]),
    [["warn", "Eager store conflict barrier failed"]],
  )

  // A turn that was already interrupted notes the write; a note that fails is reported and swallowed.
  const metrics: RecordedMetric[] = []
  const abortedLogs: RecordedLog[] = []
  const abortedCtx = recordingContext(metrics, abortedLogs)
  ;(abortedCtx as unknown as { signal: AbortSignal }).signal = AbortSignal.abort()
  const noteFailure = harness({ conflictThrowsOps: ["noteDeferredEagerWrittenPaths"] })
  assert.equal(await decorate(noteFailure, { path: "/repo/src/app.ts", ctx: abortedCtx, decoration: withNotices }), "the file was written")
  assert.deepEqual(abortedLogs.map((log) => [log.level, log.message]), [["warn", "Eager store conflict deferred-path note failed"]])
})

test("a metrics backend that fails does not fail the write, and is reported", async () => {
  const logs: RecordedLog[] = []
  const ctx = createContext()
    .with(conversationIdKey, "conversation-1")
    .with(metricsKey, {
      record() {},
      increment() { throw new Error("the metrics backend is gone") },
      gauge() {},
      histogram() {},
    } as never)
    .with(loggerKey, {
      log(_context: Context, entry: { level: string; message: string }) {
        logs.push({ level: entry.level, message: entry.message })
      },
    } as never)
  const harnessed = harness({ conflictAnswers: { syncAndPeek: { kind: "completed", events: [{ eventId: "event-1" }], reminder: "a conflict" } } })
  const result = await decorate(harnessed, { path: "/repo/src/app.ts", ctx, decoration: withNotices })
  assert.match(result, /a conflict$/)
  assert.deepEqual(logs.map((log) => [log.level, log.message]), [
    ["warn", "Eager store conflict barrier telemetry failed"],
    ["info", "Local-sync eager conflict barrier attributed"],
  ])
})

test("a reporter that throws does not fail the write", async () => {
  const harnessed = harness({ conflictAnswers: { syncAndPeek: { kind: "completed", events: [{ eventId: "event-1" }], reminder: "a conflict" } } })
  const result = await decorate(harnessed, {
    path: "/repo/src/app.ts",
    decoration: { enableAgentStoreConflictNotices: true, onWriteBarrier: () => { throw new Error("the reporter is gone") } },
  })
  assert.match(result, /a conflict$/)
})

test("a journal answer of a kind the drain does not accept is not shown even when it carries a reminder", async () => {
  const harnessed = harness({
    conflictAnswers: {
      syncAndPeek: { kind: "failed", events: [] },
      peek: { kind: "failed", events: [{ eventId: "journal-1" }], reminder: "a reminder" },
    },
  })
  assert.equal(await decorate(harnessed, { path: "/repo/src/app.ts", decoration: withNotices }), "the file was written")
  assert.deepEqual(harnessed.conflictCalls.map((call) => call.op), ["syncAndPeek", "peek"])
})

test("a journal reminder with nothing behind it is released rather than shown", async () => {
  const harnessed = harness({
    conflictAnswers: {
      syncAndPeek: { kind: "failed", events: [] },
      peek: { kind: "completed", events: [{ eventId: "journal-1" }], reminder: "" },
    },
  })
  assert.equal(await decorate(harnessed, { path: "/repo/src/app.ts", decoration: withNotices }), "the file was written")
  assert.deepEqual(harnessed.conflictCalls.map((call) => call.op), ["syncAndPeek", "peek", "release"])
})

test("a journal reminder with no event behind it is shown without acknowledging it", async () => {
  const harnessed = harness({
    conflictAnswers: {
      syncAndPeek: { kind: "failed", events: [] },
      peek: { kind: "completed", events: [], reminder: "a reminder with no event" },
    },
  })
  assert.equal(await decorate(harnessed, { path: "/repo/src/app.ts", decoration: withNotices }), "the file was written")
  assert.deepEqual(harnessed.conflictCalls.map((call) => call.op), ["syncAndPeek", "peek"])
})

test("a turn interrupted before the journal is drained releases what it found and notes the write", async () => {
  const harnessed = harness({
    conflictHandlers: {
      peek: (ctx: unknown) => {
        ;(ctx as { signal: AbortSignal }).signal = AbortSignal.abort()
        return { kind: "completed", events: [{ eventId: "journal-1" }], reminder: "from the journal" }
      },
    },
  })
  const result = await decorate(harnessed, {
    path: "/repo/src/app.ts",
    decoration: { enableAgentStoreConflictNotices: true, writeBarrierTimeoutMs: 0 },
  })
  assert.equal(result, "the file was written")
  assert.deepEqual(harnessed.conflictCalls.map((call) => call.op), ["peek", "release", "noteDeferredEagerWrittenPaths"])
})

test("a wait that ran out of time with an empty reminder falls back to the journal", async () => {
  const harnessed = harness({
    conflictAnswers: {
      syncAndPeek: { kind: "timed-out", events: [{ eventId: "event-1" }], reminder: "" },
      peek: { kind: "completed", events: [{ eventId: "journal-1" }], reminder: "from the journal" },
      ack: { kind: "acked", count: 1 },
    },
  })
  assert.match(await decorate(harnessed, { path: "/repo/src/app.ts", decoration: withNotices }), /from the journal$/)
  assert.deepEqual(harnessed.conflictCalls.map((call) => call.op), ["syncAndPeek", "peek", "ack"])
})

test("a barrier that threw counts as an error even when the journal then answers", async () => {
  const metrics: RecordedMetric[] = []
  const logs: RecordedLog[] = []
  const harnessed = harness({ conflictThrowsOps: ["syncAndPeek"], conflictAnswers: { peek: { kind: "completed", events: [] } } })
  await decorate(harnessed, { path: "/repo/src/app.ts", ctx: recordingContext(metrics, logs), decoration: withNotices })
  assert.deepEqual(metrics.map((metric) => metric.labels?.outcome), ["error"])
})

test("the deadline side of the race answers the write and leaves the eager pass to release what it holds", async () => {
  const harnessed = harness({
    conflictHandlers: {
      syncAndPeek: async () => {
        await new Promise((resolve) => setTimeout(resolve, 200))
        return { kind: "completed", events: [{ eventId: "event-1" }], reminder: "a late conflict" }
      },
    },
  })
  const outcomes: string[] = []
  const result = await decorate(harnessed, {
    path: "/repo/src/app.ts",
    decoration: { enableAgentStoreConflictNotices: true, writeBarrierTimeoutMs: 20, onWriteBarrier: (event: { outcome: string }) => outcomes.push(event.outcome) },
  })
  assert.equal(result, "the file was written")
  assert.deepEqual(outcomes, ["timeout"])
  // The eager pass that lost the race still releases its events and notes the write.
  await new Promise((resolve) => setTimeout(resolve, 300))
  assert.deepEqual(harnessed.conflictCalls.map((call) => call.op), ["syncAndPeek", "noteDeferredEagerWrittenPaths", "release", "noteDeferredEagerWrittenPaths"])
  // A late pass cannot report a second outcome.
  assert.deepEqual(outcomes, ["timeout"])
})

test("a logger that fails on the attribution line does not fail the write", async () => {
  const metrics: RecordedMetric[] = []
  let ctx = createContext().with(conversationIdKey, "conversation-1")
  ctx = ctx.with(metricsKey, {
    record() {},
    increment(_context: Context, handle: { name: string }, value: number, labels?: Record<string, string>) { metrics.push({ name: handle.name, value, labels }) },
    gauge() {},
    histogram() {},
  } as never)
  ctx = ctx.with(loggerKey, {
    log() { throw new Error("the logger is gone") },
  } as never)
  const harnessed = harness({ conflictAnswers: { syncAndPeek: { kind: "completed", events: [{ eventId: "event-1" }], reminder: "a conflict" } } })
  // The attribution log is a diagnostic: a logger that cannot write it is swallowed by the barrier.
  const result = await decorate(harnessed, { path: "/repo/src/app.ts", ctx, decoration: withNotices })
  assert.match(result, /a conflict$/)
})

test("the grace time keeps an eager pass in the race after its own deadline", async () => {
  const harnessed = harness({
    conflictHandlers: {
      syncAndPeek: async () => {
        await new Promise((resolve) => setTimeout(resolve, 100))
        return { kind: "completed", events: [{ eventId: "event-1" }], reminder: "a late but attributable conflict" }
      },
      ack: () => ({ kind: "acked", count: 1 }),
    },
  })
  const outcomes: string[] = []
  const result = await decorate(harnessed, {
    path: "/repo/src/app.ts",
    decoration: { enableAgentStoreConflictNotices: true, writeBarrierTimeoutMs: 20, forceGraceTimeoutMs: 400, onWriteBarrier: (event: { outcome: string }) => outcomes.push(event.outcome) },
  })
  assert.match(result, /a late but attributable conflict$/)
  assert.deepEqual(outcomes, ["synced"])
})

test("a conflict answer may be an array with the properties the answer uses", async () => {
  const answer: unknown = Object.assign([], {
    kind: "completed",
    events: [{ eventId: "event-1" }],
    reminder: "a conflict on an array",
  })
  const harnessed = harness({ conflictAnswers: { syncAndPeek: answer, ack: { kind: "acked", count: 1 } } })
  assert.match(await decorate(harnessed, { path: "/repo/src/app.ts", decoration: withNotices }), /a conflict on an array$/)
})

test("a conflict answer whose event is not an event is not shown", async () => {
  const harnessed = harness({
    conflictAnswers: {
      syncAndPeek: { kind: "completed", events: [{ nope: true }], reminder: "a conflict" },
      peek: { kind: "completed", events: [] },
    },
  })
  assert.equal(await decorate(harnessed, { path: "/repo/src/app.ts", decoration: withNotices }), "the file was written")
})

test("a conflict answer's reminder has to be a string", async () => {
  const harnessed = harness({
    conflictAnswers: {
      syncAndPeek: { kind: "completed", events: [{ eventId: "event-1" }], reminder: 42 },
      peek: { kind: "completed", events: [] },
    },
  })
  assert.equal(await decorate(harnessed, { path: "/repo/src/app.ts", decoration: withNotices }), "the file was written")
})

test("a turn interrupted during a timed-out pass releases its events and reports the timeout", async () => {
  const harnessed = harness({
    conflictHandlers: {
      syncAndPeek: (ctx: unknown) => {
        ;(ctx as { signal: AbortSignal }).signal = AbortSignal.abort()
        return { kind: "timed-out", events: [{ eventId: "event-1" }], reminder: "a late conflict" }
      },
    },
  })
  const outcomes: string[] = []
  const result = await decorate(harnessed, {
    path: "/repo/src/app.ts",
    decoration: { enableAgentStoreConflictNotices: true, onWriteBarrier: (event: { outcome: string }) => outcomes.push(event.outcome) },
  })
  assert.equal(result, "the file was written")
  assert.deepEqual(harnessed.conflictCalls.map((call) => call.op), ["syncAndPeek", "release", "noteDeferredEagerWrittenPaths"])
  assert.deepEqual(outcomes, ["timeout"])
})

test("a release that fails on an interrupted turn does not fail the write", async () => {
  const harnessed = harness({
    conflictHandlers: {
      syncAndPeek: (ctx: unknown) => {
        ;(ctx as { signal: AbortSignal }).signal = AbortSignal.abort()
        return { kind: "completed", events: [{ eventId: "event-1" }], reminder: "a conflict" }
      },
    },
    conflictThrowsOps: ["release"],
  })
  const outcomes: string[] = []
  assert.equal(await decorate(harnessed, {
    path: "/repo/src/app.ts",
    decoration: { enableAgentStoreConflictNotices: true, onWriteBarrier: (event: { outcome: string }) => outcomes.push(event.outcome) },
  }), "the file was written")
  assert.deepEqual(outcomes, ["synced"])
})

test("a timed-out pass that is attributed writes no attribution line", async () => {
  const metrics: RecordedMetric[] = []
  const logs: RecordedLog[] = []
  const harnessed = harness({ conflictAnswers: { syncAndPeek: { kind: "timed-out", events: [{ eventId: "event-1" }], reminder: "a late conflict" }, ack: { kind: "acked", count: 1 } } })
  const result = await decorate(harnessed, { path: "/repo/src/app.ts", ctx: recordingContext(metrics, logs), decoration: withNotices })
  assert.match(result, /a late conflict$/)
  assert.deepEqual(logs, [])
  assert.deepEqual(metrics.map((metric) => metric.labels?.outcome), ["attributed_timed_out"])
})

test("the deadline fires after a winning eager pass without noting the write again", async () => {
  const harnessed = harness({
    conflictAnswers: {
      syncAndPeek: { kind: "completed", events: [{ eventId: "event-1" }], reminder: "a conflict" },
      ack: { kind: "acked", count: 1 },
    },
  })
  const outcomes: string[] = []
  const result = await decorate(harnessed, {
    path: "/repo/src/app.ts",
    decoration: { enableAgentStoreConflictNotices: true, writeBarrierTimeoutMs: 20, onWriteBarrier: (event: { outcome: string }) => outcomes.push(event.outcome) },
  })
  assert.match(result, /a conflict$/)
  // The race deadline is 40ms; the eager pass has already won by then.
  await new Promise((resolve) => setTimeout(resolve, 120))
  assert.deepEqual(harnessed.conflictCalls.map((call) => call.op), ["syncAndPeek", "ack"])
  assert.deepEqual(outcomes, ["synced"])
})