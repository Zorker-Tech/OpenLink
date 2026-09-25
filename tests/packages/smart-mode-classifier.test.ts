import { test } from "node:test"
import assert from "node:assert/strict"

import { createContext, type Context } from "../../source/packages/context/context.ts"
import { loggerKey } from "../../source/packages/context/logging.ts"
import { agentEventTrackerKey, type AgentEventTracker } from "../../source/packages/agent/utils/event-tracking.ts"
import {
  SmartModeClassifierDecision,
  SmartModeClassifierArgs,
  SmartModeClassifierResult,
} from "../../source/packages/proto/generated/agent/v1/smart_mode_classifier_exec_pb.ts"
import { ExecutorResource, type RemoteExecManager } from "../../source/packages/agent-exec/executor-resources.ts"
import { createServerSerializer, createClientDeserializer } from "../../source/packages/agent-exec/exec-serialization.ts"
import {
  executeSmartModeClassifierWithMeasurement,
  smartModeClassifierAttemptIndexKey,
  smartModeClassifierModeKey,
  smartModeClassifierWorkspacePathsKey,
} from "../../source/packages/agent/utils/smart-mode-classifier-measurement.ts"

type AnyRecord = Record<string, any>

const measured: AnyRecord[] = []

/** Each check starts from an empty record, so it can assert on what its own call reported. */
function measuredTest(name: string, body: () => Promise<void>): void {
  test(name, async () => {
    measured.length = 0
    await body()
  })
}

function testContext(): Context {
  const tracker = {
    trackSmartModeClassifierCall: (_ctx: Context, options: AnyRecord) => {
      measured.push(options)
    },
  } as unknown as AgentEventTracker
  return createContext().with(agentEventTrackerKey, tracker)
}

/** An executor that answers however the test wants and records the context each attempt saw. */
function executorAnswering(
  answer: (attempt: number) => SmartModeClassifierResult | Promise<SmartModeClassifierResult>,
): { executor: { execute: (ctx: Context, args: SmartModeClassifierArgs) => Promise<SmartModeClassifierResult> }; attempts: AnyRecord[] } {
  const attempts: AnyRecord[] = []
  return {
    attempts,
    executor: {
      async execute(context: Context, _args: SmartModeClassifierArgs) {
        attempts.push({
          attemptIndex: context.get(smartModeClassifierAttemptIndexKey),
          mode: context.get(smartModeClassifierModeKey),
          workspacePaths: context.get(smartModeClassifierWorkspacePathsKey),
        })
        return await answer(attempts.length)
      },
    },
  }
}

const successResult = (decision: SmartModeClassifierDecision, blockReason?: string): SmartModeClassifierResult =>
  new SmartModeClassifierResult({
    result: { case: "success", value: { decision, ...(blockReason !== undefined ? { blockReason } : {}) } },
  })

const errorResult = (error: string): SmartModeClassifierResult =>
  new SmartModeClassifierResult({ result: { case: "error", value: { error } } })

const missingResult = (): SmartModeClassifierResult =>
  new SmartModeClassifierResult({ result: { case: undefined } })

function argsFor(action: string | undefined, executionSurface?: string): SmartModeClassifierArgs {
  return new SmartModeClassifierArgs({
    toolCallId: "call-1",
    ...(action !== undefined || executionSurface !== undefined
      ? {
        target: {
          action: action ?? "",
          ...(executionSurface !== undefined ? { arguments: { type: "object" } as never } : {}),
        },
      }
      : {}),
  })
}

// ---------------------------------------------------------------------------------------------
// the decision is what the caller gets
// ---------------------------------------------------------------------------------------------

measuredTest("an allow is returned as it came", async () => {
  const { executor } = executorAnswering(() => successResult(SmartModeClassifierDecision.ALLOW))
  const result = await executeSmartModeClassifierWithMeasurement(testContext(), executor as never, argsFor("shell"))
  assert.equal(result.result.case, "success")
  assert.equal(measured.length, 1)
  assert.equal(measured.at(-1)?.outcome, "allow")
  assert.equal(measured.at(-1)?.decision, "allow")
  assert.equal(measured.at(-1)?.retryCount, 0)
})

measuredTest("a block is returned as it came, with the reason it was given", async () => {
  const { executor } = await Promise.resolve(executorAnswering(() => successResult(SmartModeClassifierDecision.BLOCK, "not allowed")))
  const result = await executeSmartModeClassifierWithMeasurement(testContext(), executor as never, argsFor("shell"))
  assert.equal(result.result.case, "success")
  assert.equal(measured.at(-1)?.outcome, "block")
  assert.equal(measured.at(-1)?.hasReason, true)
  assert.equal(measured.at(-1)?.retryable, false)
})

measuredTest("a decision that was not made is retried, and reported as unspecified", async () => {
  const { executor, attempts } = executorAnswering(attempt =>
    attempt === 1 ? successResult(SmartModeClassifierDecision.UNSPECIFIED) : successResult(SmartModeClassifierDecision.ALLOW))
  const result = await executeSmartModeClassifierWithMeasurement(testContext(), executor as never, argsFor("shell"))
  assert.equal(attempts.length, 2)
  assert.equal(result.result.case, "success")
  assert.equal(measured.length, 1)
  assert.equal(measured.at(-1)?.outcome, "allow")
  assert.equal(measured.at(-1)?.retryCount, 1)
})

measuredTest("a decision that is still missing after the last attempt is reported, not retried forever", async () => {
  const { executor, attempts } = executorAnswering(() => successResult(SmartModeClassifierDecision.UNSPECIFIED))
  const result = await executeSmartModeClassifierWithMeasurement(testContext(), executor as never, argsFor("shell"))
  assert.equal(attempts.length, 2)
  assert.equal(result.result.case, "success")
  assert.equal(measured.at(-1)?.outcome, "missing")
  assert.equal(measured.at(-1)?.failureReason, "unspecified_decision")
  assert.equal(measured.at(-1)?.retryCount, 1)
})

measuredTest("an error result is retried when its metadata says it is worth retrying", async () => {
  const { executor, attempts } = executorAnswering(attempt =>
    attempt === 1
      ? errorResult('\n\nSmartModeClassifierFailureMetadata:{"failureReason":"classifier_overloaded","retryable":true}')
      : successResult(SmartModeClassifierDecision.ALLOW))
  const result = await executeSmartModeClassifierWithMeasurement(testContext(), executor as never, argsFor("shell"))
  assert.equal(attempts.length, 2)
  assert.equal(result.result.case, "success")
})

measuredTest("an error result that says it is not retryable is returned straight away", async () => {
  const { executor, attempts } = executorAnswering(() =>
    errorResult('\n\nSmartModeClassifierFailureMetadata:{"failureReason":"policy","retryable":false}'))
  const result = await executeSmartModeClassifierWithMeasurement(testContext(), executor as never, argsFor("shell"))
  assert.equal(attempts.length, 1)
  assert.equal(result.result.case, "error")
  assert.equal(measured.at(-1)?.outcome, "error")
  assert.equal(measured.at(-1)?.failureReason, "policy")
  assert.equal(measured.at(-1)?.retryable, false)
})

measuredTest("an error result with no metadata is treated as retryable and named generically", async () => {
  const { executor, attempts } = executorAnswering(() => errorResult("something went wrong"))
  await executeSmartModeClassifierWithMeasurement(testContext(), executor as never, argsFor("shell"))
  assert.equal(attempts.length, 2)
  assert.equal(measured.at(-1)?.failureReason, "classifier_result_error")
  assert.equal(measured.at(-1)?.retryable, true)
})

measuredTest("a result carrying nothing at all is retried and named", async () => {
  const { executor, attempts } = executorAnswering(() => missingResult())
  await executeSmartModeClassifierWithMeasurement(testContext(), executor as never, argsFor("shell"))
  assert.equal(attempts.length, 2)
  assert.equal(measured.at(-1)?.outcome, "missing")
  assert.equal(measured.at(-1)?.failureReason, "missing_result")
})

measuredTest("the number of attempts can be capped by the caller", async () => {
  const { executor, attempts } = executorAnswering(() => successResult(SmartModeClassifierDecision.UNSPECIFIED))
  await executeSmartModeClassifierWithMeasurement(testContext(), executor as never, argsFor("shell"), "enforce", undefined, { maxAttempts: 1 })
  assert.equal(attempts.length, 1)
})

measuredTest("an attempt count below one is raised to one rather than skipping the call", async () => {
  const { executor, attempts } = executorAnswering(() => successResult(SmartModeClassifierDecision.ALLOW))
  await executeSmartModeClassifierWithMeasurement(testContext(), executor as never, argsFor("shell"), "enforce", undefined, { maxAttempts: 0 })
  assert.equal(attempts.length, 1)
})

// ---------------------------------------------------------------------------------------------
// failures that are not decisions
// ---------------------------------------------------------------------------------------------

measuredTest("a failure is retried, and the last one is thrown rather than swallowed", async () => {
  const { executor, attempts } = executorAnswering(() => {
    throw new Error("the classifier is unreachable")
  })
  await assert.rejects(
    executeSmartModeClassifierWithMeasurement(testContext(), executor as never, argsFor("shell")),
    /the classifier is unreachable/,
  )
  assert.equal(attempts.length, 2)
  assert.equal(measured.length, 1)
  assert.equal(measured.at(-1)?.outcome, "exception")
  assert.equal(measured.at(-1)?.failureReason, "unknown_exception")
  assert.equal(measured.at(-1)?.retryCount, 1)
})

measuredTest("a failure that recovers on the second attempt is not reported as a failure", async () => {
  const { executor, attempts } = executorAnswering(attempt => {
    if (attempt === 1) throw new Error("transient")
    return successResult(SmartModeClassifierDecision.ALLOW)
  })
  const result = await executeSmartModeClassifierWithMeasurement(testContext(), executor as never, argsFor("shell"))
  assert.equal(attempts.length, 2)
  assert.equal(result.result.case, "success")
  assert.equal(measured.at(-1)?.outcome, "allow")
})

measuredTest("a timeout is named as one", async () => {
  const { executor } = executorAnswering(() => {
    const error = new Error("the call took too long")
    error.name = "TimeoutError"
    throw error
  })
  await assert.rejects(
    executeSmartModeClassifierWithMeasurement(testContext(), executor as never, argsFor("shell"), "enforce", undefined, { maxAttempts: 1 }),
    /the call took too long/,
  )
  assert.equal(measured.at(-1)?.failureReason, "timeout_exception")
})

measuredTest("a cancellation is not a failure and is not retried", async () => {
  const { executor, attempts } = executorAnswering(() => {
    const error = new Error("aborted by the user")
    error.name = "AbortError"
    throw error
  })
  await assert.rejects(
    executeSmartModeClassifierWithMeasurement(testContext(), executor as never, argsFor("shell")),
    /aborted by the user/,
  )
  assert.equal(attempts.length, 1)
  assert.equal(measured.at(-1)?.outcome, "exception")
  assert.equal(measured.at(-1)?.failureReason, undefined)
})

measuredTest("the attempt runs under a context that follows the turn's cancellation", async () => {
  const [parentCtx, cancelParent] = testContext().withCancel()
  let aborted = false
  const executor = {
    async execute(context: Context) {
      context.signal.addEventListener("abort", () => {
        aborted = true
      }, { once: true })
      cancelParent(new Error("the user stopped the turn"))
      await new Promise(resolve => setTimeout(resolve, 5))
      return successResult(SmartModeClassifierDecision.ALLOW)
    },
  }
  await executeSmartModeClassifierWithMeasurement(
    parentCtx,
    executor as never,
    argsFor("shell"),
    "enforce",
    undefined,
    { maxAttempts: 1 },
  )
  assert.equal(aborted, true)
})

// ---------------------------------------------------------------------------------------------
// what the measurement reports
// ---------------------------------------------------------------------------------------------

measuredTest("each attempt sees which attempt it is, the mode, and the workspace", async () => {
  const { executor, attempts } = executorAnswering(() => successResult(SmartModeClassifierDecision.ALLOW))
  await executeSmartModeClassifierWithMeasurement(
    testContext(),
    executor as never,
    argsFor("shell"),
    "observe",
    ["/one", "/two"],
  )
  assert.deepEqual(attempts[0], { attemptIndex: 0, mode: "observe", workspacePaths: ["/one", "/two"] })
})

measuredTest("the second attempt is numbered as such", async () => {
  const { executor, attempts } = executorAnswering(attempt =>
    attempt === 1 ? successResult(SmartModeClassifierDecision.UNSPECIFIED) : successResult(SmartModeClassifierDecision.ALLOW))
  await executeSmartModeClassifierWithMeasurement(testContext(), executor as never, argsFor("shell"))
  assert.equal(attempts[1]?.attemptIndex, 1)
})

measuredTest("the action is reported by kind, and an unknown action is just other", async () => {
  for (const [action, expected] of [
    ["shell", "shell"],
    ["MCP", "mcp"],
    ["slate_computer", "slate_computer"],
    ["web_fetch", "web_fetch"],
    ["fetch_mcp_resource", "fetch_mcp_resource"],
    ["edit_file", "other"],
    ["", "unknown"],
    [undefined, "unknown"],
  ] as const) {
    measured.length = 0
    const { executor } = executorAnswering(() => successResult(SmartModeClassifierDecision.ALLOW))
    await executeSmartModeClassifierWithMeasurement(testContext(), executor as never, argsFor(action))
    assert.equal(measured.at(-1)?.actionKind, expected, String(action))
  }
})

measuredTest("the surface is reported only when the classifier was told one", async () => {
  const withSurface = argsFor("shell")
  withSurface.target!.arguments = { toJson: () => ({ execution_surface: "isolated_box" }) } as never
  const { executor } = executorAnswering(() => successResult(SmartModeClassifierDecision.ALLOW))
  await executeSmartModeClassifierWithMeasurement(testContext(), executor as never, withSurface)
  assert.equal(measured.at(-1)?.surfaceLabel, "isolated_box")

  measured.length = 0
  const withoutSurface = argsFor("shell")
  withoutSurface.target!.arguments = { toJson: () => ({ execution_surface: "somewhere_else" }) } as never
  const second = executorAnswering(() => successResult(SmartModeClassifierDecision.ALLOW))
  await executeSmartModeClassifierWithMeasurement(testContext(), second.executor as never, withoutSurface)
  assert.equal(measured.at(-1)?.surfaceLabel, undefined)
})

measuredTest("a call is reported with how long it took and how many attempts it took", async () => {
  const { executor } = executorAnswering(async attempt => {
    if (attempt === 1) return successResult(SmartModeClassifierDecision.UNSPECIFIED)
    await new Promise(resolve => setTimeout(resolve, 5))
    return successResult(SmartModeClassifierDecision.BLOCK, "no")
  })
  await executeSmartModeClassifierWithMeasurement(testContext(), executor as never, argsFor("shell"))
  assert.equal(measured.at(-1)?.retryCount, 1)
  assert.equal(typeof measured.at(-1)?.latencyMs, "number")
  assert.ok((measured.at(-1)?.latencyMs ?? -1) >= 5)
})

measuredTest("the tool call id is logged unless the caller asked for it not to be", async () => {
  const entries: AnyRecord[] = []
  const capturing = (): Context => testContext().with(loggerKey, {
    log: (_ctx: Context, entry: AnyRecord) => entries.push(entry),
  } as never)
  const { executor } = executorAnswering(() => successResult(SmartModeClassifierDecision.ALLOW))
  await executeSmartModeClassifierWithMeasurement(capturing(), executor as never, argsFor("shell"))
  const call = entries.find(entry => entry.message === "smart_mode.classifier_call")
  const started = entries.find(entry => entry.message === "smart_mode.classifier_call.started")
  assert.equal(call?.metadata?.toolCallId, "call-1")
  assert.equal(started?.metadata?.toolCallId, "call-1")

  entries.length = 0
  const second = executorAnswering(() => successResult(SmartModeClassifierDecision.ALLOW))
  await executeSmartModeClassifierWithMeasurement(
    capturing(),
    second.executor as never,
    argsFor("shell"),
    "enforce",
    undefined,
    { suppressToolCallIdLogging: true },
  )
  const suppressed = entries.find(entry => entry.message === "smart_mode.classifier_call")
  assert.equal(suppressed?.metadata?.toolCallId, undefined)
})

measuredTest("a tracker that throws does not fail the call", async () => {
  const throwingTracker = {
    trackSmartModeClassifierCall: () => {
      throw new Error("the tracker is broken")
    },
  } as unknown as AgentEventTracker
  const { executor } = executorAnswering(() => successResult(SmartModeClassifierDecision.ALLOW))
  const result = await executeSmartModeClassifierWithMeasurement(
    createContext().with(agentEventTrackerKey, throwingTracker),
    executor as never,
    argsFor("shell"),
  )
  assert.equal(result.result.case, "success")
})

measuredTest("the executor is reached through the same resource shape the platform uses", async () => {
  const manager: RemoteExecManager = {
    createExecInstance() {
      return (async function* () {})()
    },
  }
  const resource = new ExecutorResource<SmartModeClassifierArgs, SmartModeClassifierResult>(
    manager,
    createServerSerializer("smartModeClassifierArgs"),
    createClientDeserializer("smartModeClassifierResult"),
  )
  assert.equal(typeof resource.execute, "function")
})
