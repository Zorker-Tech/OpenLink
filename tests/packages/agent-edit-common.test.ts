import { test } from "node:test"
import assert from "node:assert/strict"

import {
  WritePermissionDeniedError,
  WriteRejectedError,
  performWrite,
  type PerformWriteEditInfo,
  type PerformWriteMeta,
} from "../../source/packages/agent/tools/core/edit/common.ts"
import { createContext, type Context } from "../../source/packages/context/context.ts"
import {
  CustomToolCallError,
  ToolCallError,
  ToolCallRejectedError,
  ToolCallUnexpectedEnvironmentError,
} from "../../source/packages/agent/tools/tool-errors.ts"
import { WORKTREE_GUARD_ERROR } from "../../source/packages/utils/paths.ts"
import { AgentMode } from "../../source/packages/proto/generated/agent/v1/agent_pb.ts"
import { WriteResult, WriteSuccess } from "../../source/packages/proto/generated/agent/v1/write_exec_pb.ts"
import { writeExecutorResource } from "../../source/packages/agent-exec/write-operation.ts"
import { agentStoreConflictNoticeExecutorResource } from "../../source/packages/agent-exec/agent-store-conflict-notice.ts"
import { canvasDiagnosticsExecutorResource } from "../../source/packages/agent-exec/canvas-diagnostics.ts"
import { HookAdditionalContext } from "../../source/packages/proto/generated/agent/v1/hook_additional_context_pb.ts"

// ---------------------------------------------------------------------------------------------
// the one place a file is written
// ---------------------------------------------------------------------------------------------

interface Harness {
  readonly writes: Array<{ path: string; text?: string; toolCallId?: string; execId?: string; options?: Record<string, unknown> }>
  readonly recordedStates: Array<{ path: string; content?: string; previous?: string }>
  readonly accessor: unknown
}

function harness(options: {
  write?: WriteResult | (() => never)
  noWriteExecutor?: boolean
  decorate?: boolean
} = {}): Harness {
  const writes: Harness["writes"] = []
  const recordedStates: Harness["recordedStates"] = []
  const accessor = {
    get: (resource: unknown) => {
      if (resource === writeExecutorResource) {
        if (options.noWriteExecutor === true) return undefined
        return {
          async execute(_ctx: Context, args: { path: string; fileText?: string; toolCallId?: string }, execOptions: { execId?: string } & Record<string, unknown>) {
            writes.push({
              path: args.path,
              ...(args.fileText === undefined ? {} : { text: args.fileText }),
              ...(args.toolCallId === undefined ? {} : { toolCallId: args.toolCallId }),
              ...(execOptions?.execId === undefined ? {} : { execId: execOptions.execId }),
              options: execOptions,
            })
            if (typeof options.write === "function") (options.write as () => never)()
            return options.write ?? new WriteResult({ result: { case: "success", value: new WriteSuccess({ path: args.path }) } })
          },
        }
      }
      // The decoration looks for these two and does nothing when they are absent.
      if (resource === canvasDiagnosticsExecutorResource || resource === agentStoreConflictNoticeExecutorResource) return undefined
      return undefined
    },
  }
  return { writes, recordedStates, accessor }
}

const editInfo = (overrides: Partial<PerformWriteEditInfo> = {}): PerformWriteEditInfo => ({
  resultForModel: "the file was written",
  linesAdded: 2,
  linesRemoved: 1,
  diffString: "the diff",
  originalContent: "before",
  ...overrides,
})

function stateHandler(mode: number = AgentMode.AGENT): { readonly mode: number; recordFileState(path: string, content: string | undefined, previousContent: string | undefined): void; readonly states: Array<{ path: string; content?: string; previous?: string }> } {
  const states: Array<{ path: string; content?: string; previous?: string }> = []
  return {
    mode,
    states,
    recordFileState(path, content, previousContent) {
      states.push({ path, ...(content === undefined ? {} : { content }), ...(previousContent === undefined ? {} : { previous: previousContent }) })
    },
  }
}

const write = (
  harnessed: Harness,
  options: {
    path?: string
    content?: string
    edit?: PerformWriteEditInfo
    meta?: Partial<PerformWriteMeta>
    state?: ReturnType<typeof stateHandler>
    mode?: number
  } = {},
) => performWrite(
  createContext(),
  harnessed.accessor as never,
  options.path ?? "/repo/src/app.ts",
  options.content ?? "after",
  options.edit ?? editInfo(),
  { toolCallId: "call-1", ...options.meta } as PerformWriteMeta,
  (options.state ?? stateHandler(options.mode)) as never,
)

// ---------------------------------------------------------------------------------------------
// what reaches the workspace
// ---------------------------------------------------------------------------------------------

test("a write carries the path, the content and the call it belongs to", async () => {
  const harnessed = harness()
  await write(harnessed)
  assert.equal(harnessed.writes.length, 1)
  assert.equal(harnessed.writes[0]?.path, "/repo/src/app.ts")
  assert.equal(harnessed.writes[0]?.text, "after")
  assert.equal(harnessed.writes[0]?.toolCallId, "call-1")
})

test("the write's id is derived from the call, so a retry is the same write", async () => {
  const first = harness()
  await write(first)
  const second = harness()
  await write(second)
  assert.equal(first.writes[0]?.execId, second.writes[0]?.execId)
  assert.notEqual(first.writes[0]?.execId, first.writes[0]?.toolCallId)
})

test("the hook collector and the conflict switch are passed to the workspace", async () => {
  const harnessed = harness()
  const hookContextCollector = [new HookAdditionalContext({ hookEventName: "preToolUse", content: "a hook said something" })]
  await write(harnessed, { meta: { hookContextCollector, enableAgentStoreConflictNotices: true } })
  assert.deepEqual(harnessed.writes[0]?.options?.hookContextCollector, hookContextCollector)
  assert.equal(harnessed.writes[0]?.options?.enableAgentStoreConflictNotices, true)
})

test("a write that is not asked for conflict notices does not ask for them", async () => {
  const harnessed = harness()
  await write(harnessed)
  assert.equal(harnessed.writes[0]?.options?.enableAgentStoreConflictNotices, false)
})

test("a write in plan mode to a file the plan does not cover is refused before anything is sent", async () => {
  const harnessed = harness()
  await assert.rejects(() => write(harnessed, { mode: AgentMode.PLAN }), ToolCallRejectedError)
  assert.deepEqual(harnessed.writes, [])
})

// ---------------------------------------------------------------------------------------------
// what the model is given back
// ---------------------------------------------------------------------------------------------

test("a written file's state is recorded on the conversation", async () => {
  const harnessed = harness()
  const state = stateHandler()
  await write(harnessed, { state })
  assert.deepEqual(state.states, [{ path: "/repo/src/app.ts", content: "after", previous: "before" }])
})

test("the result carries the edit's own numbers and the content on both sides", async () => {
  const harnessed = harness()
  const result = await write(harnessed)
  assert.equal(result.modified, "after")
  assert.equal(result.edit.resultForModel, "the file was written")
  assert.equal(result.edit.linesAdded, 2)
  assert.equal(result.edit.linesRemoved, 1)
  assert.equal(result.edit.diffString, "the diff")
  // The content to hand back defaults to what the edit saw.
  assert.equal(result.edit.beforeContentToReturn, "before")
  assert.equal(result.edit.afterContentToReturn, "after")
})

test("an edit that named its own content to hand back keeps it", async () => {
  const harnessed = harness()
  const result = await write(harnessed, { edit: editInfo({ beforeContentToReturn: "a slice", afterContentToReturn: "another slice" }) })
  assert.equal(result.edit.beforeContentToReturn, "a slice")
  assert.equal(result.edit.afterContentToReturn, "another slice")
})

// ---------------------------------------------------------------------------------------------
// what each failure becomes
// ---------------------------------------------------------------------------------------------

test("a refusal becomes a permission problem the user may be able to change", async () => {
  const harnessed = harness({
    write: new WriteResult({ result: { case: "permissionDenied", value: { error: "no writes here", isReadonly: true } } as never }),
  })
  await assert.rejects(
    () => write(harnessed),
    (error: unknown) => error instanceof WritePermissionDeniedError &&
      error.isReadonly === true &&
      /^Write permission denied: \/repo\/src\/app\.ts: no writes here$/.test(error.clientVisibleErrorMessage),
  )
})

test("a full disk is a device problem the turn is not judged for", async () => {
  const harnessed = harness({ write: new WriteResult({ result: { case: "noSpace", value: {} } as never }) })
  await assert.rejects(
    () => write(harnessed),
    (error: unknown) => error instanceof CustomToolCallError &&
      error.classification === "bad_user_device_state" &&
      error.clientVisibleErrorMessage === "No space left on device",
  )
})

test("a write the user rejected is a decision rather than an error", async () => {
  const harnessed = harness({ write: new WriteResult({ result: { case: "rejected", value: { reason: "the user said no" } } as never }) })
  await assert.rejects(
    () => write(harnessed),
    (error: unknown) => error instanceof WriteRejectedError &&
      error.reason === "the user said no" &&
      error.modelVisibleErrorMessage === "the user said no",
  )
})

test("a rejection caused by a missing tool call context is reported as a write failure", async () => {
  const harnessed = harness({
    write: new WriteResult({ result: { case: "rejected", value: { reason: "Failed to find tool call context for the write" } } as never }),
  })
  await assert.rejects(
    () => write(harnessed),
    (error: unknown) => error instanceof ToolCallError &&
      error.constructor === ToolCallError &&
      /^Edit rejected: Failed to find tool call context/.test(error.clientVisibleErrorMessage),
  )
})

test("a worktree guard failure is about the environment", async () => {
  const harnessed = harness({ write: new WriteResult({ result: { case: "error", value: { error: WORKTREE_GUARD_ERROR } } as never }) })
  await assert.rejects(() => write(harnessed), ToolCallUnexpectedEnvironmentError)
})

test("a notebook with no editor support is told apart from an edit that failed", async () => {
  const harnessed = harness({
    write: new WriteResult({ result: { case: "error", value: { error: "Missing viewType for notebook" } } as never }),
  })
  await assert.rejects(
    () => write(harnessed),
    (error: unknown) => error instanceof CustomToolCallError &&
      error.classification === "unexpected_environment" &&
      /retrying will not help/.test(error.modelVisibleErrorMessage),
  )
})

test("any other write failure is reported as the workspace worded it", async () => {
  const harnessed = harness({ write: new WriteResult({ result: { case: "error", value: { error: "the disk is on fire" } } as never }) })
  await assert.rejects(
    () => write(harnessed),
    (error: unknown) => error instanceof ToolCallError &&
      error.clientVisibleErrorMessage === "the disk is on fire",
  )
})

test("a workspace that answers with nothing at all is an unknown error", async () => {
  const harnessed = harness({ write: new WriteResult({}) })
  await assert.rejects(
    () => write(harnessed),
    (error: unknown) => error instanceof ToolCallError && error.clientVisibleErrorMessage === "Unknown error",
  )
})

test("a failure does not record the file as written", async () => {
  const harnessed = harness({ write: new WriteResult({ result: { case: "error", value: { error: "no" } } as never }) })
  const state = stateHandler()
  await assert.rejects(() => write(harnessed, { state }))
  assert.deepEqual(state.states, [])
})
