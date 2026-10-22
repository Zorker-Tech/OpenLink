import { test } from "node:test"
import assert from "node:assert/strict"

import { createContext, type Context } from "../../source/packages/context/context.ts"
import { agentEventTrackerKey, type AgentEventTracker } from "../../source/packages/agent/utils/event-tracking.ts"
import { conversationIdKey, requestIdKey } from "../../source/packages/agent/utils/request-scope.ts"
import { HookAdditionalContext } from "../../source/packages/proto/generated/agent/v1/hook_additional_context_pb.ts"
import { ExecuteHookArgs, ExecuteHookResult } from "../../source/packages/proto/generated/agent/v1/exec_pb.ts"
import {
  RemoteHookBlockedError,
  executeRemoteAfterAgentThoughtHook,
  executeRemotePostToolUseFailureHook,
  executeRemotePostToolUseHook,
  executeRemotePreToolUseHookWithPermissionCheck,
  executeRemoteSubagentStartHook,
  executeRemoteSubagentStopHook,
  withRemoteHooks,
} from "../../source/packages/agent/tools/remote-hooks.ts"
import {
  HOOK_DENIAL_AGENT_NOTE,
} from "../../source/packages/hooks-exec/hook-errors.ts"
import {
  ToolCallArgParseError,
  ToolCallRejectedError,
  ToolCallUnexpectedEnvironmentError,
  ToolErrorClassification,
  ToolTimeoutError,
} from "../../source/packages/agent/tools/tool-errors.ts"
import { RemoteHookBlockedError as RemoteHookBlockedErrorFromTools } from "../../source/packages/agent/tools/remote-hooks.ts"
import { classifyError } from "../../source/packages/agent/tools/tool-execution.ts"

type AnyRecord = Record<string, any>

const tracked: AnyRecord[] = []

function testContext(): Context {
  const tracker: AgentEventTracker = {
    trackHookExecuted: (_ctx: Context, event: AnyRecord) => {
      tracked.push(event)
    },
  } as unknown as AgentEventTracker
  return createContext()
    .with(agentEventTrackerKey, tracker)
    .with(conversationIdKey, "conv-1")
    .with(requestIdKey, "req-1")
}

/** A hook executor that answers with whatever the test wants, and records what it was asked. */
function executorReturning(result: AnyRecord | (() => AnyRecord), options: {
  failClosedSteps?: string[]
  throwError?: unknown
} = {}): { resourceAccessor: { get: () => AnyRecord }; calls: AnyRecord[] } {
  const calls: AnyRecord[] = []
  const executor: AnyRecord = {
    hasFailClosedHooksForStep: (step: string, toolName: string) =>
      (options.failClosedSteps ?? []).includes(step) && toolName !== "",
    async execute(_ctx: Context, args: ExecuteHookArgs) {
      calls.push(args)
      if (options.throwError !== undefined) throw options.throwError
      return typeof result === "function" ? result() : result
    },
  }
  return { resourceAccessor: { get: () => executor }, calls }
}

function hookOptions(executor: { resourceAccessor: { get: () => AnyRecord } }, extra: AnyRecord = {}): AnyRecord {
  return {
    enableExecuteHookExec: true,
    configuredSteps: ["preToolUse", "postToolUse", "postToolUseFailure", "subagentStart", "subagentStop", "afterAgentThought"],
    resourceAccessor: executor.resourceAccessor,
    hookContextCollector: [],
    model: "session-model",
    ...extra,
  }
}

const requestContext: AnyRecord = { toolCallId: "call-1" }

function preToolUseResponse(fields: AnyRecord): ExecuteHookResult {
  return new ExecuteHookResult({
    response: {
      response: {
        case: "preToolUse",
        value: {
          permission: fields.permission ?? "",
          userMessage: fields.userMessage ?? "",
          agentMessage: fields.agentMessage ?? "",
          updatedInput: fields.updatedInput ?? "",
          additionalContext: fields.additionalContext ?? "",
        },
      },
    },
  })
}

function postToolUseResponse(additionalContext: string): ExecuteHookResult {
  return new ExecuteHookResult({
    response: { response: { case: "postToolUse", value: { additionalContext } } },
  })
}

// ---------------------------------------------------------------------------------------------
// remote-hooks: a hook that is not configured, or not allowed, is not called
// ---------------------------------------------------------------------------------------------

test("nothing is asked of the host when hook execution is off", async () => {
  const executor = executorReturning(preToolUseResponse({}))
  const result = await executeRemotePreToolUseHookWithPermissionCheck({
    ctx: testContext(),
    toolName: "shell",
    toolInput: { command: "ls" },
    requestContext,
    options: hookOptions(executor, { enableExecuteHookExec: false }),
  })
  assert.deepEqual(result, {})
  assert.equal(executor.calls.length, 0)
})

test("nothing is asked of a step the workspace did not configure", async () => {
  const executor = executorReturning(preToolUseResponse({}))
  const result = await executeRemotePreToolUseHookWithPermissionCheck({
    ctx: testContext(),
    toolName: "shell",
    toolInput: {},
    requestContext,
    options: hookOptions(executor, { configuredSteps: ["postToolUse"] }),
  })
  assert.deepEqual(result, {})
  assert.equal(executor.calls.length, 0)
})

// ---------------------------------------------------------------------------------------------
// remote-hooks: the pre-call decision
// ---------------------------------------------------------------------------------------------

test("the call is sent with its tool, its input and the ids the hook is told about", async () => {
  const executor = executorReturning(preToolUseResponse({ permission: "allow" }))
  await executeRemotePreToolUseHookWithPermissionCheck({
    ctx: testContext(),
    toolName: "shell",
    toolInput: { command: "ls", nested: { deep: true } },
    requestContext,
    options: hookOptions(executor),
  })
  const sent = executor.calls[0]?.request.request.value
  assert.equal(sent.toolName, "shell")
  assert.equal(sent.toolUseId, "call-1")
  assert.equal(sent.conversationId, "conv-1")
  assert.equal(sent.generationId, "req-1")
  assert.equal(sent.model, "session-model")
  assert.deepEqual(sent.toolInput?.toJson(), { command: "ls", nested: { deep: true } })
})

test("an input that cannot be sent fails the hook call, and the call itself goes on", async () => {
  const executor = executorReturning(preToolUseResponse({ permission: "deny", userMessage: "should never be seen" }))
  const circular: AnyRecord = {}
  circular.self = circular
  const result = await executeRemotePreToolUseHookWithPermissionCheck({
    ctx: testContext(),
    toolName: "shell",
    toolInput: circular,
    requestContext,
    options: hookOptions(executor),
  })
  assert.deepEqual(result, {})
  assert.equal(executor.calls.length, 0)
  assert.equal((tracked.at(-1) as AnyRecord).status, "failed")
})

test("a refusal becomes an error the caller can tell apart from a failure", async () => {
  const executor = executorReturning(preToolUseResponse({ permission: "deny", userMessage: "not that command" }))
  await assert.rejects(
    executeRemotePreToolUseHookWithPermissionCheck({
      ctx: testContext(),
      toolName: "shell",
      toolInput: {},
      requestContext,
      options: hookOptions(executor),
    }),
    (error: unknown) => {
      assert.ok(error instanceof RemoteHookBlockedError)
      assert.equal(error.reason, "shell blocked by preToolUse hook: not that command")
      return true
    },
  )
})

test("a refusal without a word from the hook still names the tool", async () => {
  const executor = executorReturning(preToolUseResponse({ permission: "deny" }))
  await assert.rejects(
    executeRemotePreToolUseHookWithPermissionCheck({
      ctx: testContext(),
      toolName: "read_file",
      toolInput: {},
      requestContext,
      options: hookOptions(executor),
    }),
    /read_file blocked by preToolUse hook$/,
  )
})

test("asking is refused too, and says why", async () => {
  const executor = executorReturning(preToolUseResponse({ permission: "ask" }))
  await assert.rejects(
    executeRemotePreToolUseHookWithPermissionCheck({
      ctx: testContext(),
      toolName: "shell",
      toolInput: {},
      requestContext,
      options: hookOptions(executor),
    }),
    /The 'ask' permission for preToolUse hooks is not yet implemented/,
  )
})

test("a hook may rewrite the arguments, and its context is collected", async () => {
  const executor = executorReturning(preToolUseResponse({
    permission: "allow",
    updatedInput: '{"command":"ls -la"}',
    additionalContext: "  be careful  ",
  }))
  const options = hookOptions(executor)
  const result = await executeRemotePreToolUseHookWithPermissionCheck({
    ctx: testContext(),
    toolName: "shell",
    toolInput: {},
    requestContext,
    options,
  })
  assert.deepEqual(result.updatedInput, { command: "ls -la" })
  assert.deepEqual(options.hookContextCollector.map((carrier: HookAdditionalContext) => carrier.content), ["be careful"])
  assert.equal(result.hookAdditionalContexts.length, 1)
})

test("an updated input that is not JSON is dropped, and the call goes on", async () => {
  const executor = executorReturning(preToolUseResponse({ permission: "allow", updatedInput: "{not json" }))
  const result = await executeRemotePreToolUseHookWithPermissionCheck({
    ctx: testContext(),
    toolName: "shell",
    toolInput: {},
    requestContext,
    options: hookOptions(executor),
  })
  assert.equal(result.updatedInput, undefined)
})

test("context larger than a carrier may hold is dropped rather than failing the call", async () => {
  const executor = executorReturning(preToolUseResponse({ permission: "allow", additionalContext: "x".repeat(10_001) }))
  const options = hookOptions(executor)
  const result = await executeRemotePreToolUseHookWithPermissionCheck({
    ctx: testContext(),
    toolName: "shell",
    toolInput: {},
    requestContext,
    options,
  })
  assert.deepEqual(result.hookAdditionalContexts, [])
  assert.equal(options.hookContextCollector.length, 0)
})

test("an answer for another step is treated as no answer at all", async () => {
  const executor = executorReturning(postToolUseResponse("context for the wrong step"))
  const options = hookOptions(executor)
  const result = await executeRemotePreToolUseHookWithPermissionCheck({
    ctx: testContext(),
    toolName: "shell",
    toolInput: {},
    requestContext,
    options,
  })
  assert.deepEqual(result, {})
  assert.equal(options.hookContextCollector.length, 0)
})

test("a hook that fails is let through when it is not configured to fail closed", async () => {
  const executor = executorReturning({}, { throwError: new Error("the hook process died") })
  const result = await executeRemotePreToolUseHookWithPermissionCheck({
    ctx: testContext(),
    toolName: "shell",
    toolInput: {},
    requestContext,
    options: hookOptions(executor),
  })
  assert.deepEqual(result, {})
  const event = tracked.at(-1) as AnyRecord
  assert.equal(event.status, "failed")
  assert.equal(event.failClosed, false)
})

test("a hook that fails closed blocks the call and explains itself", async () => {
  const executor = executorReturning({}, { throwError: new Error("the hook process died"), failClosedSteps: ["preToolUse"] })
  await assert.rejects(
    executeRemotePreToolUseHookWithPermissionCheck({
      ctx: testContext(),
      toolName: "shell",
      toolInput: {},
      requestContext,
      options: hookOptions(executor),
    }),
    (error: unknown) => {
      assert.ok(error instanceof RemoteHookBlockedError)
      assert.match(error.reason, /shell blocked by preToolUse hook/)
      assert.match(error.reason, /configured to fail closed/)
      assert.match(error.reason, /the hook process died/)
      return true
    },
  )
  const event = tracked.at(-1) as AnyRecord
  assert.equal(event.failClosed, true)
  assert.equal(event.status, "blocked")
})

test("a timeout is reported as a timeout, not as a failure", async () => {
  const executor = executorReturning({}, { throwError: new Error("the hook timed out after 30 seconds") })
  await executeRemotePreToolUseHookWithPermissionCheck({
    ctx: testContext(),
    toolName: "shell",
    toolInput: {},
    requestContext,
    options: hookOptions(executor),
  })
  const event = tracked.at(-1) as AnyRecord
  assert.equal(event.status, "timeout")
  assert.equal(event.timedOut, true)
})

// ---------------------------------------------------------------------------------------------
// remote-hooks: after the call
// ---------------------------------------------------------------------------------------------

test("a post-tool hook contributes its context and nothing else", async () => {
  const executor = executorReturning(postToolUseResponse("  the output was truncated  "))
  const options = hookOptions(executor)
  const contexts = await executeRemotePostToolUseHook({
    ctx: testContext(),
    toolName: "shell",
    toolInput: { command: "ls" },
    toolOutput: "a b c",
    durationMs: 12.6,
    requestContext,
    options,
  })
  assert.deepEqual(contexts.map(carrier => carrier.content), ["the output was truncated"])
  assert.deepEqual(options.hookContextCollector.map((carrier: HookAdditionalContext) => carrier.content), ["the output was truncated"])
  const sent = executor.calls[0]?.request.request.value
  assert.equal(sent.durationMs, 13n)
  assert.equal(sent.toolOutput, "a b c")
})

test("a failing post-tool hook costs the context, not the turn", async () => {
  const executor = executorReturning({}, { throwError: new Error("hook failed") })
  const contexts = await executeRemotePostToolUseHook({
    ctx: testContext(),
    toolName: "shell",
    toolInput: {},
    toolOutput: "",
    durationMs: 1,
    requestContext,
    options: hookOptions(executor),
  })
  assert.deepEqual(contexts, [])
})

test("a failure hook is told what failed and how long the call took", async () => {
  const executor = executorReturning(new ExecuteHookResult({
    response: { response: { case: "postToolUseFailure", value: { additionalContext: "try a smaller glob" } } },
  }))
  const contexts = await executeRemotePostToolUseFailureHook({
    ctx: testContext(),
    toolName: "grep",
    toolInput: { pattern: "*" },
    errorMessage: "too many files",
    failureType: "timeout",
    durationMs: 5_000,
    requestContext,
    options: hookOptions(executor),
  })
  assert.deepEqual(contexts.map(carrier => carrier.content), ["try a smaller glob"])
  const sent = executor.calls[0]?.request.request.value
  assert.equal(sent.errorMessage, "too many files")
  assert.equal(sent.failureType, "timeout")
  assert.equal(sent.durationMs, 5_000n)
  assert.equal(sent.isInterrupt, false)
})

// ---------------------------------------------------------------------------------------------
// remote-hooks: the subagent lifecycle
// ---------------------------------------------------------------------------------------------

test("a subagent start is asked, and its answer is passed through", async () => {
  const executor = executorReturning(new ExecuteHookResult({
    response: { response: { case: "subagentStart", value: { permission: "deny", userMessage: "no subagents here" } } },
  }))
  const result = await executeRemoteSubagentStartHook({
    ctx: testContext(),
    subagentId: "sub-1",
    subagentType: "explore",
    task: "find the callers",
    subagentModel: "sub-model",
    isParallelWorker: true,
    gitBranch: "dev",
    requestContext,
    options: hookOptions(executor),
  })
  assert.deepEqual(result, { permission: "deny", userMessage: "no subagents here" })
  const sent = executor.calls[0]?.request.request.value
  assert.equal(sent.subagentId, "sub-1")
  assert.equal(sent.parentConversationId, "conv-1")
  assert.equal(sent.isParallelWorker, true)
})

test("an answer for another step leaves the subagent unblocked", async () => {
  const executor = executorReturning(postToolUseResponse("wrong step"))
  const result = await executeRemoteSubagentStartHook({
    ctx: testContext(),
    subagentId: "sub-1",
    subagentType: "explore",
    task: "t",
    requestContext,
    options: hookOptions(executor),
  })
  assert.deepEqual(result, {})
})

test("a subagent start that fails is rethrown, because the subagent must not start", async () => {
  const executor = executorReturning({}, { throwError: new Error("hook backend down") })
  await assert.rejects(
    executeRemoteSubagentStartHook({
      ctx: testContext(),
      subagentId: "sub-1",
      subagentType: "explore",
      task: "t",
      requestContext,
      options: hookOptions(executor),
    }),
    /hook backend down/,
  )
})

test("a subagent stop passes the follow-up message back, trimmed", async () => {
  const executor = executorReturning(new ExecuteHookResult({
    response: { response: { case: "subagentStop", value: { followupMessage: "  also check the tests  " } } },
  }))
  const result = await executeRemoteSubagentStopHook({
    ctx: testContext(),
    subagentId: "sub-1",
    subagentType: "explore",
    status: "completed",
    durationMs: 1_234.7,
    summary: "found them",
    messageCount: 12,
    toolCallCount: 4,
    modifiedFiles: ["a.ts"],
    requestContext,
    options: hookOptions(executor),
  })
  assert.deepEqual(result, { followupMessage: "also check the tests" })
  const sent = executor.calls[0]?.request.request.value
  assert.equal(sent.durationMs, 1_235n)
  assert.equal(sent.status, "completed")
  assert.deepEqual(sent.modifiedFiles, ["a.ts"])
})

test("an after-thought hook is observed and never changes the turn", async () => {
  const executor = executorReturning(new ExecuteHookResult())
  await executeRemoteAfterAgentThoughtHook({
    ctx: testContext(),
    text: "thinking about it",
    durationMs: 40,
    requestContext,
    options: hookOptions(executor),
  })
  const sent = executor.calls[0]?.request.request.value
  assert.equal(sent.text, "thinking about it")
  assert.equal(sent.durationMs, 40n)
  const event = tracked.at(-1) as AnyRecord
  assert.equal(event.hookStep, "afterAgentThought")
  assert.equal(event.status, "success")
})

test("an after-thought hook that fails is recorded and swallowed", async () => {
  const executor = executorReturning({}, { throwError: new Error("hook timed out") })
  await executeRemoteAfterAgentThoughtHook({
    ctx: testContext(),
    text: "t",
    durationMs: 1,
    requestContext,
    options: hookOptions(executor),
  })
  const event = tracked.at(-1) as AnyRecord
  assert.equal(event.status, "timeout")
})

test("a hook is told which model the call chose, and the session's model when it chose none", async () => {
  const executor = executorReturning(preToolUseResponse({ permission: "allow" }))
  await executeRemotePreToolUseHookWithPermissionCheck({
    ctx: testContext(),
    toolName: "shell",
    toolInput: {},
    requestContext: { toolCallId: "call-1", model: "call-model", modelId: "call-model-id" },
    options: hookOptions(executor),
  })
  const sent = executor.calls[0]?.request.request.value
  assert.equal(sent.model, "call-model")
  assert.equal(sent.modelId, "call-model-id")
})

// ---------------------------------------------------------------------------------------------
// remote-hooks: wrapping a tool's execution
// ---------------------------------------------------------------------------------------------

function wrapConfig(overrides: AnyRecord = {}): AnyRecord {
  return {
    toolName: "shell",
    createToolInput: (args: AnyRecord) => ({ command: args.command }),
    createRejectedResult: (_args: AnyRecord, reason: string) => ({ rejected: reason }),
    createSuccessOutput: (_args: AnyRecord, result: unknown) => ({ ok: result }),
    ...overrides,
  }
}

test("a denied call never reaches the tool", async () => {
  const executor = executorReturning(preToolUseResponse({ permission: "deny", userMessage: "no" }))
  let ran = false
  const wrapped = withRemoteHooks({
    executeFn: async () => {
      ran = true
      return "ran"
    },
    config: wrapConfig(),
    requestContext,
    options: hookOptions(executor),
  })
  assert.deepEqual(await wrapped(testContext(), { command: "rm -rf /" }), { rejected: "no" })
  assert.equal(ran, false)
})

test("an updated input is applied before the tool runs", async () => {
  const executor = executorReturning(preToolUseResponse({ permission: "allow", updatedInput: '{"command":"ls -la"}' }))
  const args: AnyRecord = { command: "ls" }
  const wrapped = withRemoteHooks({
    executeFn: async (_ctx: Context, toolArgs: AnyRecord) => toolArgs.command,
    config: wrapConfig({
      applyUpdatedInput: (toolArgs: AnyRecord, updated: AnyRecord) => {
        toolArgs.command = updated.command
      },
    }),
    requestContext,
    options: hookOptions(executor),
  })
  assert.equal(await wrapped(testContext(), args), "ls -la")
})

test("a successful call is reported to the post-tool hook with its output", async () => {
  const executor = executorReturning(postToolUseResponse("noted"))
  const wrapped = withRemoteHooks({
    executeFn: async () => "the output",
    config: wrapConfig(),
    requestContext,
    options: hookOptions(executor),
  })
  assert.equal(await wrapped(testContext(), { command: "ls" }), "the output")
  assert.equal(executor.calls.length, 2)
  assert.equal(executor.calls[1]?.request.request.case, "postToolUse")
  assert.equal(executor.calls[1]?.request.request.value.toolOutput, JSON.stringify({ ok: "the output" }))
})

test("a tool that throws is reported to the failure hook before the error is rethrown", async () => {
  const executor = executorReturning(new ExecuteHookResult({
    response: { response: { case: "postToolUseFailure", value: {} } },
  }))
  const wrapped = withRemoteHooks({
    executeFn: async () => {
      throw new Error("the command failed")
    },
    config: wrapConfig(),
    requestContext,
    options: hookOptions(executor),
  })
  await assert.rejects(wrapped(testContext(), { command: "ls" }), /the command failed/)
  assert.equal(executor.calls.length, 2)
  assert.equal(executor.calls[1]?.request.request.case, "postToolUseFailure")
  assert.equal(executor.calls[1]?.request.request.value.errorMessage, "the command failed")
  assert.equal(executor.calls[1]?.request.request.value.failureType, "error")
})

test("a timeout is reported to the failure hook as a timeout", async () => {
  const executor = executorReturning(new ExecuteHookResult({
    response: { response: { case: "postToolUseFailure", value: {} } },
  }))
  const wrapped = withRemoteHooks({
    executeFn: async () => {
      throw new ToolTimeoutError({ clientVisibleErrorMessage: "t", modelVisibleErrorMessage: "t", error: "t" })
    },
    config: wrapConfig(),
    requestContext,
    options: hookOptions(executor),
  })
  await assert.rejects(wrapped(testContext(), { command: "ls" }), ToolTimeoutError)
  assert.equal(executor.calls[1]?.request.request.case, "postToolUseFailure")
  assert.equal(executor.calls[1]?.request.request.value.failureType, "timeout")
})

test("a tool that reports failure in its result is reported to the failure hook", async () => {
  const executor = executorReturning(new ExecuteHookResult({
    response: { response: { case: "postToolUseFailure", value: {} } },
  }))
  const wrapped = withRemoteHooks({
    executeFn: async () => "a result that says it failed",
    config: wrapConfig({
      getFailureInfo: (result: unknown) => ({ errorMessage: String(result), failureType: "error" }),
    }),
    requestContext,
    options: hookOptions(executor),
  })
  assert.equal(await wrapped(testContext(), { command: "ls" }), "a result that says it failed")
  assert.equal(executor.calls[1]?.request.request.case, "postToolUseFailure")
  assert.equal(executor.calls[1]?.request.request.value.errorMessage, "a result that says it failed")
})

test("a failure hook that itself fails does not replace the tool's own error", async () => {
  const executor = executorReturning({}, { throwError: new Error("hook backend down") })
  const wrapped = withRemoteHooks({
    executeFn: async () => {
      throw new Error("the command failed")
    },
    config: wrapConfig(),
    requestContext,
    options: hookOptions(executor),
  })
  await assert.rejects(wrapped(testContext(), { command: "ls" }), /the command failed/)
})

// ---------------------------------------------------------------------------------------------
// tool-execution: what a failure is called
// ---------------------------------------------------------------------------------------------

test("a hook denial is classified as a hook denial", () => {
  assert.equal(classifyError(new RemoteHookBlockedErrorFromTools("no", "no")), ToolErrorClassification.HOOK_DENIED)
  assert.equal(
    classifyError(new ToolCallRejectedError(`rejected. ${HOOK_DENIAL_AGENT_NOTE}`)),
    ToolErrorClassification.HOOK_DENIED,
  )
})

test("a plain rejection is the user's, not a hook's", () => {
  assert.equal(classifyError(new ToolCallRejectedError("the user said no")), ToolErrorClassification.USER_REJECTED)
})

test("arguments that did not parse are an argument problem", () => {
  assert.equal(classifyError(new ToolCallArgParseError("bad json")), ToolErrorClassification.INVALID_ARGS)
})

test("a missing path is an environment problem, and a full disk is the device's", () => {
  assert.equal(
    classifyError(Object.assign(new Error("nope"), { code: "ENOENT" })),
    ToolErrorClassification.UNEXPECTED_ENVIRONMENT,
  )
  assert.equal(
    classifyError(Object.assign(new Error("no space left on device"), { code: "ENOSPC" })),
    ToolErrorClassification.BAD_USER_DEVICE_STATE,
  )
  assert.equal(
    classifyError(new Error("not a directory")),
    ToolErrorClassification.UNEXPECTED_ENVIRONMENT,
  )
})

test("a timeout is a timeout whether it came from the platform or the socket", () => {
  assert.equal(
    classifyError(new ToolTimeoutError({ clientVisibleErrorMessage: "t", modelVisibleErrorMessage: "t", error: "t" })),
    ToolErrorClassification.TIMEOUT,
  )
  assert.equal(
    classifyError(Object.assign(new Error("socket timeout"), { code: "ETIMEDOUT" })),
    ToolErrorClassification.TIMEOUT,
  )
})

test("an unrecognized failure is just an error", () => {
  assert.equal(classifyError(new Error("something else")), ToolErrorClassification.OTHER_ERROR)
  assert.equal(classifyError("a string"), ToolErrorClassification.OTHER_ERROR)
})

test("the hook is told the conversation and request ids, with the call as the last resort", async () => {
  const executor = executorReturning(new ExecuteHookResult({}))
  const options = hookOptions(executor)
  await executeRemoteAfterAgentThoughtHook({ ctx: testContext(), text: "t", requestContext: { toolCallId: "call-1" }, options })
  const request = executor.calls[0]?.request?.request
  assert.equal(request?.case, "afterAgentThought")
  const value = request?.value as AnyRecord
  assert.equal(value.conversationId, "conv-1")
  assert.equal(value.generationId, "req-1")

  const bareCtx = createContext().with(agentEventTrackerKey, { trackHookExecuted: () => {} } as unknown as AgentEventTracker)
  const bare = executorReturning(new ExecuteHookResult({}))
  await executeRemoteAfterAgentThoughtHook({ ctx: bareCtx, text: "t", requestContext: { toolCallId: "call-9" }, options: hookOptions(bare) })
  const bareValue = bare.calls[0]?.request?.request?.value as AnyRecord
  assert.equal(bareValue.conversationId, "call-9")
  assert.equal(bareValue.generationId, "call-9")
})

test("a hook that fails without stating fail-closed lets the tool run", async () => {
  const executor = { async execute() { throw new Error("boom") } }
  const options = hookOptions({ resourceAccessor: { get: () => executor } } as never)
  const result = await executeRemotePreToolUseHookWithPermissionCheck({ ctx: testContext(), toolName: "shell", toolInput: {}, requestContext, options })
  assert.deepEqual(result, {})
})

test("a wrapper refuses an ask permission instead of running the tool", async () => {
  const executor = executorReturning(preToolUseResponse({ permission: "ask" }))
  let ran = false
  const wrapped = withRemoteHooks({
    ctx: testContext(),
    executeFn: async () => { ran = true; return { value: 1 } },
    config: {
      toolName: "shell",
      createToolInput: () => ({ command: "ls" }),
      createRejectedResult: (_raw: AnyRecord, message: string) => ({ rejected: message }),
      createSuccessOutput: (_raw: AnyRecord, result: unknown) => ({ output: result }),
    },
    requestContext,
    options: hookOptions(executor),
  })
  const result = await wrapped(testContext(), { command: "ls" })
  assert.equal(ran, false)
  assert.deepEqual(result, { rejected: "The 'ask' permission for preToolUse hooks is not yet implemented" })
})
