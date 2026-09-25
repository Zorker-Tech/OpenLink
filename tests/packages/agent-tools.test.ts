import { test } from "node:test"
import assert from "node:assert/strict"

import { Code, ConnectError } from "@connectrpc/connect"
import { z } from "zod"

import { createContext, createKey } from "../../source/packages/context/context.ts"
import { ErrorDetails, ErrorDetails_Error } from "../../source/packages/proto/generated/aiserver/v1/utils_pb.ts"
import {
  CustomToolCallError,
  RetryableToolEnvironmentOrchestrationError,
  RetryableToolOrchestrationError,
  ToolCallAbortedError,
  ToolCallArgParseError,
  ToolCallError,
  ToolErrorClassification,
  ToolTimeoutError,
} from "../../source/packages/agent/tools/tool-errors.ts"
import {
  BACKGROUND_SHELL_DEFAULT_BLOCK_UNTIL_MS,
  EXTRA_LONG_TOOL_TIMEOUT_MS,
  EXTRA_SHORT_TOOL_TIMEOUT_MS,
  FusedStepGuardTimeoutError,
  LONG_TOOL_TIMEOUT_MS,
  MEDIUM_TOOL_TIMEOUT_MS,
  SHORT_TOOL_TIMEOUT_MS,
  TOOL_CALL_TIMEOUT_TIERS_MS,
  buildToolCallExecutionTimedOutMessage,
  isFusedStepGuardTimeoutReason,
  isSubagentToolName,
  parseBlockUntilMs,
  pickToolCallTimeoutTierMs,
  suggestedToolTimeoutMs,
  toolCallExecutionGuardMs,
} from "../../source/packages/agent/tools/tool-execution-timeout.ts"
import {
  toolExecutionTimeoutSuspensionKey,
  withToolExecutionTimeoutSuspended,
  type ToolExecutionTimeoutSuspension,
} from "../../source/packages/agent/tools/tool-timeout-suspension.ts"
import {
  CHAR_HARD_LIMIT,
  computeSubagentRequestId,
  convertTupleSchemaToDraft2020_12,
  createToolCallExecutionTimeoutError,
  createZodAgentTool,
  generateSeededUuid,
  isCodexPromptVersion,
  resolveTerminalsFolder,
  truncateOutput,
  withSafeParsedArgs,
  wrapToolWithTimeout,
} from "../../source/packages/agent/tools/tool-support.ts"
import {
  getConnectErrorCode,
  isAgentStreamStartTimeoutError,
  isAgentStreamStartTimeoutRecoveryTurnError,
  maybeCreateAgentStreamStartTimeoutTurnError,
  maybeNormalizeExecBoundaryError,
} from "../../source/packages/agent/tools/connect-errors.ts"

const ctx = (): ReturnType<typeof createContext> => createContext()

async function* argsOf(...chunks: string[]): AsyncIterable<string> {
  for (const chunk of chunks) yield chunk
}

function stateHandlerReporting(needsStrip: boolean): { needsMarkerTokenStripping: () => boolean } {
  return { needsMarkerTokenStripping: () => needsStrip }
}

// ---------------------------------------------------------------------------------------------
// tool-errors: the two audiences and the classification that travels with the failure
// ---------------------------------------------------------------------------------------------

test("a tool call error carries one message per audience", () => {
  const error = new ToolCallError({
    clientVisibleErrorMessage: "shown to the user",
    modelVisibleErrorMessage: "shown to the model",
    error: "the raw failure",
  })
  assert.equal(error.message, "the raw failure")
  assert.equal(error.clientVisibleErrorMessage, "shown to the user")
  assert.equal(error.modelVisibleErrorMessage, "shown to the model")
  assert.ok(error instanceof Error)
})

test("a custom tool call error keeps the classification it was raised with", () => {
  const error = new CustomToolCallError(ToolErrorClassification.PROVIDER_ERROR, {
    clientVisibleErrorMessage: "rate limited",
    modelVisibleErrorMessage: "rate limited",
    error: "rate limited",
  })
  assert.equal(error.classification, "provider_error")
  assert.ok(error instanceof ToolCallError)
})

test("the parse and abort errors repeat their single reason to both audiences", () => {
  const parseError = new ToolCallArgParseError("Invalid arguments:\ncount: Expected number")
  assert.equal(parseError.message, parseError.modelVisibleErrorMessage)
  assert.equal(parseError.clientVisibleErrorMessage, parseError.modelVisibleErrorMessage)
  assert.ok(parseError instanceof ToolCallError)

  const aborted = new ToolCallAbortedError()
  assert.equal(aborted.message, "Aborted")
  assert.equal(aborted.modelVisibleErrorMessage, "Aborted")
})

test("a timeout error is a tool call error so callers can catch both", () => {
  const timeout = new ToolTimeoutError({
    clientVisibleErrorMessage: "timed out",
    modelVisibleErrorMessage: "timed out",
    error: "timed out",
  })
  assert.ok(timeout instanceof ToolCallError)
  assert.equal(timeout.message, "timed out")
})

test("a retryable orchestration error is flagged retryable and keeps its cause", () => {
  const cause = new Error("socket closed")
  const error = new RetryableToolOrchestrationError("try again", {
    classification: ToolErrorClassification.OTHER_ERROR,
    cause,
  })
  assert.equal(error.name, "RetryableToolOrchestrationError")
  assert.equal(error.isRetryable, true)
  assert.equal(error.classification, "error")
  assert.equal(error.cause, cause)
})

test("a retryable orchestration error without options has no classification and no cause", () => {
  const error = new RetryableToolOrchestrationError("try again")
  assert.equal(error.classification, undefined)
  assert.equal(error.cause, undefined)
})

test("an unreachable environment is retryable but classified as an environment problem", () => {
  const cause = new Error("pod gone")
  const error = new RetryableToolEnvironmentOrchestrationError("environment unreachable", { cause })
  assert.ok(error instanceof RetryableToolOrchestrationError)
  assert.equal(error.classification, "unexpected_environment")
  assert.equal(error.code, "ENVIRONMENT_UNREACHABLE")
  assert.equal(error.cause, cause)
})

test("an unreachable environment can be reported under a caller's own code", () => {
  const error = new RetryableToolEnvironmentOrchestrationError("gone", { code: "POD_NOT_FOUND" })
  assert.equal(error.code, "POD_NOT_FOUND")
  assert.equal(error.cause, undefined)
})

// ---------------------------------------------------------------------------------------------
// tool-execution-timeout: picking a limit, and saying what happened when it is reached
// ---------------------------------------------------------------------------------------------

test("the timeout tiers ascend from five minutes to two hours", () => {
  assert.deepEqual(TOOL_CALL_TIMEOUT_TIERS_MS, [
    EXTRA_SHORT_TOOL_TIMEOUT_MS,
    SHORT_TOOL_TIMEOUT_MS,
    MEDIUM_TOOL_TIMEOUT_MS,
    LONG_TOOL_TIMEOUT_MS,
    EXTRA_LONG_TOOL_TIMEOUT_MS,
  ])
  assert.deepEqual(
    [EXTRA_SHORT_TOOL_TIMEOUT_MS, SHORT_TOOL_TIMEOUT_MS, MEDIUM_TOOL_TIMEOUT_MS, LONG_TOOL_TIMEOUT_MS, EXTRA_LONG_TOOL_TIMEOUT_MS],
    [300_000, 900_000, 1_800_000, 3_600_000, 7_200_000],
  )
  assert.equal(BACKGROUND_SHELL_DEFAULT_BLOCK_UNTIL_MS, 600_000)
})

test("block_until_ms is read from an object, a JSON string, and nowhere else", () => {
  assert.equal(parseBlockUntilMs({ block_until_ms: 5_000 }), 5_000)
  assert.equal(parseBlockUntilMs({ block_until_ms: 0 }), 0)
  assert.equal(parseBlockUntilMs('{"block_until_ms":1200}'), 1_200)
  assert.equal(parseBlockUntilMs('{"block_until_ms":1200'), undefined)
  assert.equal(parseBlockUntilMs('"a string"'), undefined)
  assert.equal(parseBlockUntilMs({ block_until_ms: -1 }), undefined)
  assert.equal(parseBlockUntilMs({ block_until_ms: "5000" }), undefined)
  assert.equal(parseBlockUntilMs({ block_until_ms: Number.NaN }), undefined)
  assert.equal(parseBlockUntilMs({ block_until_ms: Number.POSITIVE_INFINITY }), undefined)
  assert.equal(parseBlockUntilMs({}), undefined)
  assert.equal(parseBlockUntilMs(null), undefined)
  assert.equal(parseBlockUntilMs(undefined), undefined)
})

test("the long-running tool names are matched case-insensitively", () => {
  assert.equal(isSubagentToolName("task"), true)
  assert.equal(isSubagentToolName("mcp_task"), true)
  assert.equal(isSubagentToolName("SUBAGENT"), true)
  assert.equal(isSubagentToolName("Subagent"), true)
  assert.equal(isSubagentToolName("shell"), false)
  assert.equal(isSubagentToolName("task_manager"), false)
})

test("a subagent gets the long tier regardless of what it asked for", () => {
  assert.equal(suggestedToolTimeoutMs("task", {}), LONG_TOOL_TIMEOUT_MS)
  assert.equal(suggestedToolTimeoutMs("subagent", { block_until_ms: 1 }), LONG_TOOL_TIMEOUT_MS)
})

test("an ordinary tool gets the short tier, or its request plus a one minute buffer", () => {
  assert.equal(suggestedToolTimeoutMs("shell", {}), SHORT_TOOL_TIMEOUT_MS)
  assert.equal(suggestedToolTimeoutMs("shell", { block_until_ms: 0 }), 60_000)
  assert.equal(suggestedToolTimeoutMs("shell", { block_until_ms: 600_000 }), 660_000)
})

test("a request larger than every tier still gets a number, not a crash", () => {
  const suggested = suggestedToolTimeoutMs("shell", { block_until_ms: EXTRA_LONG_TOOL_TIMEOUT_MS * 2 })
  assert.equal(suggested, EXTRA_LONG_TOOL_TIMEOUT_MS * 2 + 60_000)
  assert.equal(pickToolCallTimeoutTierMs(suggested), EXTRA_LONG_TOOL_TIMEOUT_MS)
})

test("the tier is the smallest one that covers the request", () => {
  assert.equal(pickToolCallTimeoutTierMs(0), EXTRA_SHORT_TOOL_TIMEOUT_MS)
  assert.equal(pickToolCallTimeoutTierMs(EXTRA_SHORT_TOOL_TIMEOUT_MS), EXTRA_SHORT_TOOL_TIMEOUT_MS)
  assert.equal(pickToolCallTimeoutTierMs(EXTRA_SHORT_TOOL_TIMEOUT_MS + 1), SHORT_TOOL_TIMEOUT_MS)
  assert.equal(pickToolCallTimeoutTierMs(SHORT_TOOL_TIMEOUT_MS), SHORT_TOOL_TIMEOUT_MS)
  assert.equal(pickToolCallTimeoutTierMs(LONG_TOOL_TIMEOUT_MS + 1), EXTRA_LONG_TOOL_TIMEOUT_MS)
})

test("the guard sits one minute under the tier when nothing was requested", () => {
  assert.equal(toolCallExecutionGuardMs("shell", {}), SHORT_TOOL_TIMEOUT_MS - 60_000)
  assert.equal(toolCallExecutionGuardMs("task", {}), LONG_TOOL_TIMEOUT_MS - 60_000)
})

test("a long block extends the guard by a thirty second grace", () => {
  // 600s of block plus the one minute buffer stays inside the 900s tier, so the guard is its 840s headroom.
  assert.equal(toolCallExecutionGuardMs("shell", { block_until_ms: 600_000 }), 840_000)
  // 840s lands exactly on the tier, and the grace takes the guard above the headroom but still under the tier.
  assert.equal(toolCallExecutionGuardMs("shell", { block_until_ms: 840_000 }), 870_000)
})

test("a block that outgrows its tier moves the guard up with it", () => {
  // 900s + 60s buffer = 960s, past the 900s tier, so both the tier and the guard step up to the 1800s one.
  assert.equal(toolCallExecutionGuardMs("shell", { block_until_ms: 900_000 }), 1_740_000)
})

test("the guard never reaches the tier it is guarding, even at the top tier", () => {
  // Past two hours there is no larger tier to step up to, so the grace is dropped rather than the guard raised.
  assert.equal(toolCallExecutionGuardMs("shell", { block_until_ms: EXTRA_LONG_TOOL_TIMEOUT_MS - 30_000 }), EXTRA_LONG_TOOL_TIMEOUT_MS - 60_000)
})

test("the timeout message names the tool, the limit in seconds, and the way out for a shell", () => {
  const shell = buildToolCallExecutionTimedOutMessage({ toolName: "shell", executionTimeoutMs: 900_000 })
  assert.match(shell, /^The shell tool call timed out after 900 seconds and was terminated\./)
  assert.match(shell, /block_until_ms/)

  const read = buildToolCallExecutionTimedOutMessage({ toolName: "read_file", executionTimeoutMs: 900_000 })
  assert.match(read, /^The read_file tool call timed out after 900 seconds/)
  assert.doesNotMatch(read, /block_until_ms/)

  const rounded = buildToolCallExecutionTimedOutMessage({ toolName: "shell", executionTimeoutMs: 1_500 })
  assert.match(rounded, /after 2 seconds/)
})

test("a zero limit means the call never started, and says so", () => {
  const message = buildToolCallExecutionTimedOutMessage({ toolName: "shell", executionTimeoutMs: 0 })
  assert.match(message, /could not start because activity setup exceeded the per-call time limit/)
  assert.doesNotMatch(message, /timed out after/)
})

test("the shell hint is matched case-insensitively on the tool name", () => {
  assert.match(buildToolCallExecutionTimedOutMessage({ toolName: "Shell", executionTimeoutMs: 1 }), /block_until_ms/)
})

test("a fused step guard timeout reports its own budget in seconds", () => {
  const error = new FusedStepGuardTimeoutError(90_000)
  assert.equal(error.name, "FusedStepGuardTimeoutError")
  assert.equal(error.fuseGuardMs, 90_000)
  assert.equal(error.message, "Fused model/tool step exceeded guard timeout after 90 seconds")
  assert.equal(isFusedStepGuardTimeoutReason(error), true)
})

test("a fused step guard timeout is recognized by name when it crossed a boundary", () => {
  const lookalike = new Error("Fused model/tool step exceeded guard timeout after 5 seconds")
  lookalike.name = "FusedStepGuardTimeoutError"
  ;(lookalike as unknown as { fuseGuardMs: number }).fuseGuardMs = 5_000
  assert.equal(isFusedStepGuardTimeoutReason(lookalike), true)
  assert.equal(isFusedStepGuardTimeoutReason(new Error("nope")), false)
  assert.equal(isFusedStepGuardTimeoutReason(undefined), false)

  const missingBudget = new Error("same name, no budget")
  missingBudget.name = "FusedStepGuardTimeoutError"
  assert.equal(isFusedStepGuardTimeoutReason(missingBudget), false)
})

test("a timeout error built from a tool name reaches both audiences with the timeout text", () => {
  const error = createToolCallExecutionTimeoutError({ toolName: "shell", executionTimeoutMs: 0 })
  assert.ok(error instanceof ToolTimeoutError)
  assert.match(error.message, /could not start/)
  assert.equal(error.clientVisibleErrorMessage, error.message)
  assert.equal(error.modelVisibleErrorMessage, error.message)
})

// ---------------------------------------------------------------------------------------------
// tool-timeout-suspension: a call blocked on a person is not a call that is slow
// ---------------------------------------------------------------------------------------------

test("the suspension key is undefined until something suspends on it", () => {
  assert.equal(createContext().get(toolExecutionTimeoutSuspensionKey), undefined)
})

test("suspending without a suspension in the context just runs the function", async () => {
  const result = await withToolExecutionTimeoutSuspended(createContext(), () => "done")
  assert.equal(result, "done")
})

test("a suspended call resumes the timeout even when the function throws", async () => {
  let suspends = 0
  let resumes = 0
  const suspension: ToolExecutionTimeoutSuspension = {
    suspend: () => {
      suspends += 1
      return () => {
        resumes += 1
      }
    },
  }
  const context = createContext().with(toolExecutionTimeoutSuspensionKey, suspension)

  assert.equal(await withToolExecutionTimeoutSuspended(context, async () => 7), 7)
  await assert.rejects(withToolExecutionTimeoutSuspended(context, async () => {
    throw new Error("inner failure")
  }), /inner failure/)

  assert.equal(suspends, 2)
  assert.equal(resumes, 2)
})

test("a nested suspension reaches the enclosing call through the context", async () => {
  const order: string[] = []
  const suspension: ToolExecutionTimeoutSuspension = {
    suspend: () => {
      order.push("suspend")
      return () => order.push("resume")
    },
  }
  const context = createContext().with(toolExecutionTimeoutSuspensionKey, suspension)
  await withToolExecutionTimeoutSuspended(context, async () => {
    order.push("work")
  })
  assert.deepEqual(order, ["suspend", "work", "resume"])
})

// ---------------------------------------------------------------------------------------------
// tool-support: seeded ids, output caps, schema conversion and the argument boundary
// ---------------------------------------------------------------------------------------------

test("a seeded uuid is stable, well formed, and differs by seed", () => {
  const first = generateSeededUuid("seed-a")
  assert.equal(first, generateSeededUuid("seed-a"))
  assert.notEqual(first, generateSeededUuid("seed-b"))
  assert.match(first, /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/)
})

test("a subagent request id is derived from the tool call id", () => {
  const id = computeSubagentRequestId("call-1")
  assert.equal(id, computeSubagentRequestId("call-1"))
  assert.notEqual(id, computeSubagentRequestId("call-2"))
  assert.match(id, /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/)
  assert.notEqual(id, generateSeededUuid("call-1"))
})

test("an output under the cap passes through untouched", () => {
  const short = "a".repeat(10)
  assert.deepEqual(truncateOutput(short, 10), { output: short, truncated: false })
  assert.deepEqual(truncateOutput(short, 100), { output: short, truncated: false })
})

test("an over-long output keeps its head and says it was cut", () => {
  const result = truncateOutput("x".repeat(50), 10)
  assert.equal(result.truncated, true)
  assert.equal(result.output, `${"x".repeat(10)}\n\n... (output truncated)`)
})

test("an over-long output that matters at both ends keeps both", () => {
  const result = truncateOutput(`HEAD${"m".repeat(100)}TAIL`, 20, true)
  assert.equal(result.truncated, true)
  assert.equal(result.output, `HEAD${"m".repeat(6)}\n\n... (output truncated) ...\n\n${"m".repeat(6)}TAIL`)
  assert.ok(result.output.includes("HEAD"))
  assert.ok(result.output.includes("TAIL"))
})

test("the default cap is the platform's character hard limit", () => {
  const exactly = "y".repeat(CHAR_HARD_LIMIT)
  assert.equal(truncateOutput(exactly).truncated, false)
  assert.equal(truncateOutput(`${exactly}z`).truncated, true)
})

test("tuple schemas are converted to the draft the providers read", () => {
  assert.deepEqual(
    convertTupleSchemaToDraft2020_12({
      type: "object",
      properties: { pair: { type: "array", items: [{ type: "string" }, { type: "number" }], additionalItems: false } },
    }),
    {
      type: "object",
      properties: { pair: { type: "array", prefixItems: [{ type: "string" }, { type: "number" }], items: false } },
    },
  )
})

test("a tuple with a remaining-items schema converts it to items", () => {
  assert.deepEqual(
    convertTupleSchemaToDraft2020_12({ items: [{ type: "string" }], additionalItems: { type: "boolean" } }),
    { prefixItems: [{ type: "string" }], items: { type: "boolean" } },
  )
})

test("a plain array schema keeps its items, and non-objects pass through", () => {
  assert.deepEqual(convertTupleSchemaToDraft2020_12({ items: { type: "string" } }), { items: { type: "string" } })
  // additionalItems only means something next to a tuple; on its own it is not carried over.
  assert.deepEqual(convertTupleSchemaToDraft2020_12({ additionalItems: false }), {})
  assert.equal(convertTupleSchemaToDraft2020_12(null), null)
  assert.equal(convertTupleSchemaToDraft2020_12("text"), "text")
  assert.deepEqual(convertTupleSchemaToDraft2020_12([{ items: [{ type: "string" }] }]), [{ prefixItems: [{ type: "string" }] }])
})

test("the tool schema reaches the model without the artifacts it rejects", () => {
  const tool = createZodAgentTool("read_file", {
    name: "read_file",
    parameters: z.object({ path: z.string().describe("the file to read") }),
    render: () => undefined,
    execute: async () => undefined,
    serializeError: error => error,
  })
  const parameters = tool.parameters as { jsonSchema?: Record<string, unknown> } & Record<string, unknown>
  assert.equal(tool.name, "read_file")
  assert.equal(tool.toolIdentifier, "read_file")
  assert.equal(parameters.jsonSchema?.$schema, undefined)
  assert.equal(parameters.jsonSchema?.definitions, undefined)
  assert.equal(parameters.jsonSchema?.additionalProperties, undefined)
  const properties = parameters.jsonSchema?.properties as Record<string, Record<string, unknown>>
  assert.equal(properties.path?.type, "string")
  assert.equal(properties.path?.description, "the file to read")
})

test("a nested schema artifact is stripped at every depth", () => {
  const tool = createZodAgentTool("nested", {
    name: "nested",
    parameters: z.object({
      inner: z.object({ value: z.string().default("x").describe("a value") }),
    }),
    render: () => undefined,
    execute: async () => undefined,
    serializeError: error => error,
  })
  const jsonSchema = (tool.parameters as { jsonSchema: Record<string, unknown> }).jsonSchema
  const inner = (jsonSchema.properties as Record<string, Record<string, unknown>>).inner!
  const value = (inner.properties as Record<string, Record<string, unknown>>).value!
  assert.equal(value.default, undefined)
  assert.equal(value.type, "string")
})

test("a tool execution runs under its own span and is attributed to the tool", async () => {
  let seen: unknown
  const tool = createZodAgentTool("shell", {
    name: "shell",
    parameters: z.object({}),
    render: () => undefined,
    execute: async (context: unknown) => {
      seen = context
      return "ran"
    },
    serializeError: error => error,
  })
  const result = await (tool.execute as (a: unknown, b: unknown, c: unknown, d: unknown) => Promise<unknown>)(
    ctx(), undefined, argsOf("{}"), { toolCallId: "call-1" },
  )
  assert.equal(result, "ran")
  assert.notEqual(seen, undefined)
})

test("a tool's own error serializer is used to shape failures", () => {
  const tool = createZodAgentTool("shell", {
    name: "shell",
    parameters: z.object({}),
    render: () => undefined,
    execute: async () => undefined,
    serializeError: error => ({ serialized: String(error) }),
  })
  assert.deepEqual((tool.serializeError as (e: unknown) => unknown)("boom"), { serialized: "boom" })
})

test("arguments are parsed and handed to the tool only once they are valid", async () => {
  const received: unknown[] = []
  const execute = withSafeParsedArgs(
    z.object({ count: z.number() }),
    async (_context, _handler, args) => {
      received.push(args)
      return "executed"
    },
    { tool: { case: "count_things" } },
  )
  const result = await execute(
    ctx(),
    { emitPartialToolCall: () => {} },
    argsOf('{"count":', "3}"),
    { toolCallId: "call-1" },
  )
  assert.equal(result, "executed")
  assert.deepEqual(received, [{ count: 3 }])
})

test("the initial partial tool call is emitted before the arguments are read", async () => {
  const emitted: unknown[] = []
  const execute = withSafeParsedArgs(
    z.object({}),
    async () => "executed",
    { tool: { case: "shell" } },
  )
  await execute(
    ctx(),
    { emitPartialToolCall: (_context, toolCallId, call) => emitted.push([toolCallId, call]) },
    argsOf("{}"),
    { toolCallId: "call-9" },
  )
  assert.deepEqual(emitted, [["call-9", { tool: { case: "shell" } }]])
})

test("a caller can suppress the initial partial tool call", async () => {
  const emitted: unknown[] = []
  const execute = withSafeParsedArgs(
    z.object({}),
    async () => "executed",
    { tool: { case: "shell" } },
    { emitInitialPartialToolCall: false },
  )
  await execute(
    ctx(),
    { emitPartialToolCall: (_context, toolCallId, call) => emitted.push([toolCallId, call]) },
    argsOf("{}"),
    { toolCallId: "call-9" },
  )
  assert.equal(emitted.length, 0)
})

test("arguments that are not JSON are rejected with a re-issue instruction", async () => {
  let ran = false
  const execute = withSafeParsedArgs(
    z.object({ count: z.number() }),
    async () => {
      ran = true
      return "executed"
    },
    { tool: { case: "count_things" } },
  )
  await assert.rejects(
    execute(ctx(), { emitPartialToolCall: () => {} }, argsOf("{not json"), { toolCallId: "call-1" }),
    (error: unknown) => {
      assert.ok(error instanceof ToolCallArgParseError)
      assert.match(error.message, /were not valid JSON/)
      assert.match(error.message, /single well-formed JSON object/)
      return true
    },
  )
  assert.equal(ran, false)
})

test("arguments that fail the schema are rejected with the offending paths", async () => {
  const execute = withSafeParsedArgs(
    z.object({ count: z.number(), nested: z.object({ flag: z.boolean() }) }),
    async () => "executed",
    { tool: { case: "count_things" } },
  )
  await assert.rejects(
    execute(ctx(), { emitPartialToolCall: () => {} }, argsOf('{"count":"three","nested":{"flag":"yes"}}'), { toolCallId: "call-1" }),
    (error: unknown) => {
      assert.ok(error instanceof ToolCallArgParseError)
      assert.match(error.message, /^Invalid arguments:\n/)
      assert.match(error.message, /count: /)
      assert.match(error.message, /nested\.flag: /)
      return true
    },
  )
})

test("a schema chosen per call is resolved from the call's own metadata", async () => {
  const received: unknown[] = []
  const execute = withSafeParsedArgs(
    meta => ("toolCallId" in meta && meta.toolCallId === "strict" ? z.object({ count: z.number() }) : z.object({ count: z.string() })),
    async (_context, _handler, args) => {
      received.push(args)
      return "executed"
    },
    { tool: { case: "count_things" } },
  )
  await execute(ctx(), { emitPartialToolCall: () => {} }, argsOf('{"count":"three"}'), { toolCallId: "loose" })
  await assert.rejects(
    execute(ctx(), { emitPartialToolCall: () => {} }, argsOf('{"count":"three"}'), { toolCallId: "strict" }),
    ToolCallArgParseError,
  )
  assert.deepEqual(received, [{ count: "three" }])
})

test("a leaked model marker is stripped from the arguments before they are parsed", async () => {
  const received: unknown[] = []
  const execute = withSafeParsedArgs(
    z.object({ count: z.number() }),
    async (_context, _handler, args) => {
      received.push(args)
      return "executed"
    },
    { tool: { case: "count_things" } },
  )
  await execute(
    ctx(),
    { emitPartialToolCall: () => {} },
    argsOf('<|redacted_tool_call_begin|>{"count":1}<|redacted_tool_call_end|>'),
    { toolCallId: "call-1", stateHandler: stateHandlerReporting(true) },
  )
  assert.deepEqual(received, [{ count: 1 }])
})

test("markers are left alone when the call says the model does not leak them", async () => {
  const execute = withSafeParsedArgs(
    z.object({ count: z.number() }),
    async () => "executed",
    { tool: { case: "count_things" } },
  )
  await assert.rejects(
    execute(
      ctx(),
      { emitPartialToolCall: () => {} },
      argsOf('<|redacted_tool_call_begin|>{"count":1}'),
      { toolCallId: "call-1", stateHandler: stateHandlerReporting(false) },
    ),
    ToolCallArgParseError,
  )
})

test("a missing or malformed state handler means no stripping", async () => {
  const received: unknown[] = []
  const execute = withSafeParsedArgs(
    z.object({ count: z.number() }),
    async (_context, _handler, args) => {
      received.push(args)
      return "executed"
    },
    { tool: { case: "count_things" } },
  )
  await execute(ctx(), { emitPartialToolCall: () => {} }, argsOf('{"count":1}'), { toolCallId: "call-1", stateHandler: {} })
  await execute(ctx(), { emitPartialToolCall: () => {} }, argsOf('{"count":2}'), { toolCallId: "call-2" })
  assert.deepEqual(received, [{ count: 1 }, { count: 2 }])
})

test("a failing argument stream is reported as an argument parse failure", async () => {
  const execute = withSafeParsedArgs(
    z.object({}),
    async () => "executed",
    { tool: { case: "shell" } },
  )
  async function* failing(): AsyncIterable<string> {
    yield "{"
    throw new Error("stream reset")
  }
  await assert.rejects(
    execute(ctx(), { emitPartialToolCall: () => {} }, failing(), { toolCallId: "call-1" }),
    (error: unknown) => {
      assert.ok(error instanceof ToolCallArgParseError)
      assert.match(error.message, /stream reset/)
      return true
    },
  )
})

test("the terminals folder is resolved whether it was given or deferred", () => {
  assert.equal(resolveTerminalsFolder("/tmp/terminals"), "/tmp/terminals")
  assert.equal(resolveTerminalsFolder(() => "/resolved/later"), "/resolved/later")
})

test("only the codex prompt versions are recognized as codex prompts", () => {
  assert.equal(isCodexPromptVersion("gpt5-codex"), true)
  assert.equal(isCodexPromptVersion("codex-cloud"), true)
  assert.equal(isCodexPromptVersion("gpt-5"), false)
  assert.equal(isCodexPromptVersion(""), false)
})

test("a tool that finishes inside its limit returns its result", async () => {
  const tool = wrapToolWithTimeout(
    { name: "quick", execute: async () => "done" },
    { timeoutMs: 5_000 },
  )
  const result = await (tool.execute as (a: unknown, b: unknown, c: unknown, d: unknown) => Promise<unknown>)(
    ctx(), undefined, argsOf(), { toolCallId: "call-1" },
  )
  assert.equal(result, "done")
})

test("a tool that runs too long is cancelled and reported to the caller", async () => {
  const events: string[] = []
  const tool = wrapToolWithTimeout(
    {
      name: "slow",
      execute: async (context: unknown) => {
        await new Promise<void>(resolve => {
          const signal = (context as { signal: AbortSignal }).signal
          signal.addEventListener("abort", () => resolve(), { once: true })
        })
        return "finished anyway"
      },
    },
    {
      timeoutMs: 20,
      onTimeout: () => {
        events.push("onTimeout")
      },
      createTimeoutError: event => new Error(`custom timeout for ${event.tool.name}`),
    },
  )
  await assert.rejects(
    (tool.execute as (a: unknown, b: unknown, c: unknown, d: unknown) => Promise<unknown>)(ctx(), undefined, argsOf(), { toolCallId: "call-1" }),
    /custom timeout for slow/,
  )
  assert.deepEqual(events, ["onTimeout"])
})

test("without a custom error the default timeout error names the tool and the limit", async () => {
  const tool = wrapToolWithTimeout(
    { name: "slow", execute: async () => await new Promise(() => {}) },
    { timeoutMs: 20 },
  )
  await assert.rejects(
    (tool.execute as (a: unknown, b: unknown, c: unknown, d: unknown) => Promise<unknown>)(ctx(), undefined, argsOf(), { toolCallId: "call-1" }),
    /Tool slow timed out after 20 ms/,
  )
})

test("time spent suspended does not count against the tool's limit", async () => {
  let sawSuspension = false
  const tool = wrapToolWithTimeout(
    {
      name: "waiting",
      execute: async (context: unknown) => {
        const suspension = (context as { get: (key: typeof toolExecutionTimeoutSuspensionKey) => ToolExecutionTimeoutSuspension | undefined })
          .get(toolExecutionTimeoutSuspensionKey)
        sawSuspension = suspension !== undefined
        const resume = suspension!.suspend()
        await new Promise(resolve => setTimeout(resolve, 80))
        resume()
        return "waited for the user"
      },
    },
    { timeoutMs: 30 },
  )
  const result = await (tool.execute as (a: unknown, b: unknown, c: unknown, d: unknown) => Promise<unknown>)(
    ctx(), undefined, argsOf(), { toolCallId: "call-1" },
  )
  assert.equal(result, "waited for the user")
  assert.equal(sawSuspension, true)
})

test("resuming twice is harmless and the timer stays armed once", async () => {
  const tool = wrapToolWithTimeout(
    {
      name: "double-resume",
      execute: async (context: unknown) => {
        const suspension = (context as { get: (key: typeof toolExecutionTimeoutSuspensionKey) => ToolExecutionTimeoutSuspension | undefined })
          .get(toolExecutionTimeoutSuspensionKey)!
        const resume = suspension.suspend()
        resume()
        resume()
        return "ok"
      },
    },
    { timeoutMs: 5_000 },
  )
  const result = await (tool.execute as (a: unknown, b: unknown, c: unknown, d: unknown) => Promise<unknown>)(
    ctx(), undefined, argsOf(), { toolCallId: "call-1" },
  )
  assert.equal(result, "ok")
})

test("a nested suspension pauses the enclosing tool's timer too", async () => {
  const tool = wrapToolWithTimeout(
    {
      name: "outer",
      execute: async (context: unknown) => {
        return await withToolExecutionTimeoutSuspended(context as ReturnType<typeof createContext>, async () => {
          await new Promise(resolve => setTimeout(resolve, 80))
          return "outer finished"
        })
      },
    },
    { timeoutMs: 30 },
  )
  const result = await (tool.execute as (a: unknown, b: unknown, c: unknown, d: unknown) => Promise<unknown>)(
    ctx(), undefined, argsOf(), { toolCallId: "call-1" },
  )
  assert.equal(result, "outer finished")
})

test("wrapping a tool preserves everything else it carries", () => {
  const wrapped = wrapToolWithTimeout(
    { name: "shell", execute: async () => "done", description: "runs commands", custom: 42 },
    { timeoutMs: 1_000 },
  )
  assert.equal((wrapped as { description?: string }).description, "runs commands")
  assert.equal((wrapped as { custom?: number }).custom, 42)
  assert.equal(wrapped.name, "shell")
})

// ---------------------------------------------------------------------------------------------
// connect-errors: reading a failure that crossed a process boundary
// ---------------------------------------------------------------------------------------------

test("a cancellation that arrives as a bare abort message is normalized", () => {
  const cause = new Error("signal is aborted without reason")
  const normalized = maybeNormalizeExecBoundaryError(cause)
  assert.ok(normalized instanceof ToolCallAbortedError)
  assert.equal((normalized as ToolCallAbortedError).cause, cause)
})

test("a disposed execution runtime becomes an unavailable backend, not a retry", () => {
  const normalized = maybeNormalizeExecBoundaryError(new Error("the execution runtime disposed while the call was in flight"))
  assert.ok(normalized instanceof CustomToolCallError)
  assert.equal((normalized as CustomToolCallError).classification, "exec_backend_unavailable")
  assert.match((normalized as CustomToolCallError).modelVisibleErrorMessage, /Do not retry tool calls/)
})

test("a named execution backend failure is recognized without reading its message", () => {
  const error = new Error("whatever text")
  error.name = "ExecBackendUnavailableError"
  const normalized = maybeNormalizeExecBoundaryError(error)
  assert.ok(normalized instanceof CustomToolCallError)
  assert.equal((normalized as CustomToolCallError).classification, "exec_backend_unavailable")
})

test("a disappeared pod, an unreachable daemon and a closed bridge all mean retry the environment", () => {
  const cases = [
    "rpc error: object not found: pod 12",
    "exec-daemon is unreachable from this host",
    "bridge transport is closed",
    "the execution environment has become unreachable",
  ]
  for (const message of cases) {
    const normalized = maybeNormalizeExecBoundaryError(new Error(message))
    assert.ok(normalized instanceof RetryableToolEnvironmentOrchestrationError, message)
    assert.equal((normalized as RetryableToolEnvironmentOrchestrationError).isRetryable, true)
  }
})

test("the failure is found in the cause chain, not just the outer message", () => {
  const inner = new Error("object not found: pod 7")
  const outer = new Error("tool call failed", { cause: inner })
  const normalized = maybeNormalizeExecBoundaryError(outer)
  assert.ok(normalized instanceof RetryableToolEnvironmentOrchestrationError)
  assert.equal((normalized as RetryableToolEnvironmentOrchestrationError).cause, outer)
})

test("connect codes become the platform's own messages and classifications", () => {
  const cases: Array<[Code, string, string]> = [
    [Code.DeadlineExceeded, "Tool failed; this may be temporary. Try again.", "error"],
    [Code.Unavailable, "Service temporarily unavailable. This may be temporary; try again.", "error"],
    [Code.NotFound, "Requested resource was not found. Check model selection and access.", "error"],
    [Code.Aborted, "Aborted", "aborted"],
    [Code.Canceled, "Aborted", "aborted"],
  ]
  for (const [code, message, classification] of cases) {
    // Connect prefixes the message with the code's snake_case name, which is what the reader parses.
    const normalized = maybeNormalizeExecBoundaryError(new ConnectError("upstream said no", code))
    assert.ok(normalized instanceof CustomToolCallError, Code[code])
    assert.equal((normalized as CustomToolCallError).message, message)
    assert.equal((normalized as CustomToolCallError).classification, classification)
  }
})

test("a resource exhaustion is only a rate limit when the text says so", () => {
  const rateLimited = maybeNormalizeExecBoundaryError(new ConnectError("too many requests", Code.ResourceExhausted))
  assert.equal((rateLimited as CustomToolCallError).classification, "provider_error")
  assert.match((rateLimited as CustomToolCallError).message, /rate limited/)

  const plain = maybeNormalizeExecBoundaryError(new ConnectError("out of memory", Code.ResourceExhausted))
  assert.equal((plain as CustomToolCallError).classification, "error")
  assert.equal((plain as CustomToolCallError).message, "Tool failed; this may be temporary. Try again.")
})

test("a failure with no recognizable code is passed through untouched", () => {
  const original = new Error("something else entirely")
  assert.equal(maybeNormalizeExecBoundaryError(original), original)
  assert.equal(maybeNormalizeExecBoundaryError("a plain string"), "a plain string")
})

test("a stream that never started becomes a non-retryable turn error naming the workspace", () => {
  const startTimeout = new Error("stream never started")
  startTimeout.name = "AgentExecStreamStartTimeoutError"
  const turnError = maybeCreateAgentStreamStartTimeoutTurnError(startTimeout)
  assert.ok(turnError instanceof ConnectError)
  assert.equal(turnError?.code, Code.DeadlineExceeded)
  assert.equal(turnError?.rawMessage, "Workspace Disconnected")
  const details = turnError!.findDetails(ErrorDetails) as ErrorDetails[]
  assert.equal(details.length, 1)
  assert.equal(details[0]!.error, ErrorDetails_Error.EXTENSION_HOST_TIMEOUT)
  assert.equal(details[0]!.details?.title, "Workspace Disconnected")
  assert.match(String(details[0]!.details?.detail), /Slate lost connection to the workspace/)
  assert.equal(details[0]!.details?.isRetryable, false)
  assert.equal(details[0]!.details?.shouldShowImmediateError, true)
  assert.equal(turnError?.cause, startTimeout)
})

test("an ordinary failure does not become a stream start timeout turn error", () => {
  assert.equal(maybeCreateAgentStreamStartTimeoutTurnError(new Error("nope")), undefined)
})

test("a stream start timeout is recognized by name alone", () => {
  const named = new Error("anything")
  named.name = "AgentExecStreamStartTimeoutError"
  assert.equal(isAgentStreamStartTimeoutError(named), true)
  assert.equal(isAgentStreamStartTimeoutError(new Error("anything")), false)
  assert.equal(isAgentStreamStartTimeoutError(undefined), false)
})

test("a recovery turn error is a deadline-exceeded connect error carrying the timeout detail", () => {
  const built = maybeCreateAgentStreamStartTimeoutTurnError(Object.assign(new Error("x"), { name: "AgentExecStreamStartTimeoutError" }))
  assert.equal(isAgentStreamStartTimeoutRecoveryTurnError(built), true)
})

test("a deadline-exceeded error without the detail is not a recovery turn error", () => {
  assert.equal(isAgentStreamStartTimeoutRecoveryTurnError(new ConnectError("plain deadline", Code.DeadlineExceeded)), false)
  assert.equal(isAgentStreamStartTimeoutRecoveryTurnError(new ConnectError("other", Code.Unavailable)), false)
  assert.equal(isAgentStreamStartTimeoutRecoveryTurnError(new Error("nope")), false)
})

test("the words of a nested cause are read, not only the outer message", () => {
  const outer = new Error("tool call failed", { cause: new Error("user aborted request") })
  assert.equal(getConnectErrorCode(outer), Code.Aborted)
})

test("the words inside a connect error's own details are read too", () => {
  const withDetails = new ConnectError("execution failed", Code.DeadlineExceeded, undefined, [
    new ErrorDetails({
      error: ErrorDetails_Error.EXTENSION_HOST_TIMEOUT,
      details: { title: "Workspace Disconnected", detail: "agent stream start timeout" },
    }),
  ])
  const normalized = maybeNormalizeExecBoundaryError(withDetails)
  assert.ok(normalized instanceof CustomToolCallError)
  assert.equal((normalized as CustomToolCallError).classification, "exec_backend_unavailable")
})

test("reading a cause cycle terminates instead of looping forever", () => {
  const first = new Error("first")
  const second = new Error("user aborted request", { cause: first })
  ;(first as { cause?: unknown }).cause = second
  assert.equal(getConnectErrorCode(first), Code.Aborted)
})

test("a connect code is read from the message prefix", () => {
  assert.equal(getConnectErrorCode(new Error("[deadline_exceeded] took too long")), Code.DeadlineExceeded)
  assert.equal(getConnectErrorCode(new Error("[resource_exhausted] slow down")), Code.ResourceExhausted)
  assert.equal(getConnectErrorCode(new Error("[unavailable] down")), Code.Unavailable)
  assert.equal(getConnectErrorCode(new Error("[not_found] missing")), Code.NotFound)
  assert.equal(getConnectErrorCode(new Error("[internal] boom")), Code.Internal)
})

test("a connect code is read from a stack that carries it", () => {
  const error = new Error("no prefix here")
  error.stack = "ConnectError: [unavailable] backend down\n    at somewhere"
  assert.equal(getConnectErrorCode(error), Code.Unavailable)
})

test("a connect code is read from the words used instead of a prefix", () => {
  assert.equal(getConnectErrorCode(new Error("user aborted request")), Code.Aborted)
  assert.equal(getConnectErrorCode(new Error("canceled")), Code.Canceled)
  assert.equal(getConnectErrorCode(new Error("request cancelled by the caller")), Code.Canceled)
  assert.equal(getConnectErrorCode(new Error("the call was cancelled")), undefined)
})

test("a prefix that is not a connect code, or no code at all, yields nothing", () => {
  const bogus = new Error("whatever")
  bogus.message = "[not_a_code] whatever"
  assert.equal(getConnectErrorCode(bogus), undefined)
  assert.equal(getConnectErrorCode(new Error("no code at all")), undefined)
  assert.equal(getConnectErrorCode("a string"), undefined)
  assert.equal(getConnectErrorCode(undefined), undefined)
})

test("the suspension key is a stable identity across imports", () => {
  const other = createKey<ToolExecutionTimeoutSuspension | undefined>(Symbol("other"), undefined)
  assert.notEqual(toolExecutionTimeoutSuspensionKey, other)
  const context = createContext().with(toolExecutionTimeoutSuspensionKey, {
    suspend: () => () => {},
  })
  assert.notEqual(context.get(toolExecutionTimeoutSuspensionKey), undefined)
  assert.equal(context.get(other), undefined)
})
