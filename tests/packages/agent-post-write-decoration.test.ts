import { test } from "node:test"
import assert from "node:assert/strict"

import { decoratePostWriteResultForModel } from "../../source/packages/agent/tools/core/edit/post-write-result-decoration.ts"
import { createContext, type Context } from "../../source/packages/context/context.ts"
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
  conflictAnswers?: Record<string, unknown>
  conflictThrows?: boolean
  noCanvasExecutor?: boolean
  noConflictExecutor?: boolean
} = {}): Harness {
  const conflictCalls: Harness["conflictCalls"] = []
  const canvasExecutor = {
    async execute() {
      if (options.diagnosticsThrows === true) throw new Error("the workspace is gone")
      return options.diagnostics ?? new CanvasDiagnosticsResult({
        result: { case: "success", value: new CanvasDiagnosticsSuccess({ path: CANVAS_PATH, diagnostics: [] }) },
      })
    },
  }
  const conflictExecutor = {
    async execute(_ctx: unknown, args: Record<string, unknown>) {
      conflictCalls.push({ op: String(args.op), args })
      if (options.conflictThrows === true) throw new Error("the store is gone")
      return (options.conflictAnswers ?? {})[String(args.op)] ?? { kind: "not-applicable", events: [] }
    },
  }
  return {
    conflictCalls,
    accessor: {
      get: (resource: unknown) => {
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
  assert.equal(result.indexOf("a canvas problem") < result.indexOf("a conflict"), true)
})
