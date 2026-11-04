/**
 * Turning a tool definition into the shape the model and the runtime expect.
 *
 * Tools are declared with zod schemas, and both sides need something else: the model needs JSON Schema
 * (and a version of it that has no `$schema`/`definitions`/markdown extras, because those are noise the
 * provider may reject), while the runtime needs a callable that parses the streamed arguments, reports
 * what went wrong when they do not parse, and refuses to run at all if it cannot. This is that
 * boundary, plus the two small things every tool call needs: an output cap and a timeout it can be
 * suspended during.
 */

import { createHash } from "node:crypto"

import { jsonSchema } from "ai"
import { zodToJsonSchema } from "zod-to-json-schema"
import type { ZodTypeAny } from "zod"

import { createKey, type Context } from "../../context/context.ts"
import { createLogger } from "../../context/logging.ts"
import { createSpan } from "../../context/telemetry.ts"
import { createHistogram } from "../../metrics/index.ts"
import { stripInteropToolMarkerTokens } from "../../../adapters/interop/inference/tool-marker-adapter.ts"
import { buildToolCallExecutionTimedOutMessage } from "./tool-execution-timeout.ts"
import {
  CustomToolCallError,
  RetryableToolEnvironmentOrchestrationError,
  RetryableToolOrchestrationError,
  ToolCallAbortedError,
  ToolCallArgParseError,
  ToolCallError,
  ToolErrorClassification,
  ToolTimeoutError,
} from "./tool-errors.ts"
import {
  toolExecutionTimeoutSuspensionKey,
  type ToolExecutionTimeoutSuspension,
} from "./tool-timeout-suspension.ts"

const logger = createLogger("tools/support")

/** A uuid derived from a seed: the same tool call always names the same subagent request. */
export function generateSeededUuid(seed: string): string {
  const hash = createHash("sha256").update(seed).digest()
  hash[6] = ((hash[6] as number) & 15) | 64
  hash[8] = ((hash[8] as number) & 63) | 128
  const hex = hash.toString("hex")
  return [hex.substring(0, 8), hex.substring(8, 12), hex.substring(12, 16), hex.substring(16, 20), hex.substring(20, 32)].join("-")
}

const SUBAGENT_REQUEST_ID_SEED_PREFIX = "subagent-request-"

export function computeSubagentRequestId(toolCallId: string): string {
  return generateSeededUuid(`${SUBAGENT_REQUEST_ID_SEED_PREFIX}${toolCallId}`)
}

export const CHAR_HARD_LIMIT = 100_000
export const ASK_MODE_MODEL_ERROR =
  "You are in ask mode and cannot run non read-only tools. Ask the user to switch to agent mode if edits are required."

const toolArgsParseSuccessRate = createHistogram("agent.tools.args_parse_success", {
  description: "Tool argument parsing success rate (1 for success, 0 for failure)",
  labelNames: ["tool_name"],
})

export interface ToolExecutionMetaLike {
  toolCallId: string
  stateHandler?: { needsMarkerTokenStripping?: () => boolean } | undefined
  [key: string]: unknown
}

function needsMarkerTokenStripping(meta: ToolExecutionMetaLike | undefined): boolean {
  const stateHandler = meta?.stateHandler
  if (stateHandler == null || typeof stateHandler !== "object") return false
  return typeof stateHandler.needsMarkerTokenStripping === "function" &&
    stateHandler.needsMarkerTokenStripping.call(stateHandler) === true
}

/** Some models leak their tool-call markers into the arguments; they are noise, not content. */
function stripMarkerTokensFromArgs(options: { ctx: Context; args: string; toolName: string; strip: boolean }): string {
  if (!options.strip) return options.args
  const result = stripInteropToolMarkerTokens(options.args)
  for (const token of result.removedMarkers) {
    logger.warn(options.ctx, "agent.tools.marker_token_leaked", { tool_name: options.toolName, token })
  }
  return result.text
}

export const agentToolExecutionMetaKey = createKey<unknown>(Symbol("agentToolExecutionMeta"), undefined)

/** Caps an output, keeping the end as well when both ends matter (a diff, a stack trace). */
export function truncateOutput(
  output: string,
  maxLength = CHAR_HARD_LIMIT,
  frontAndBack = false,
): { output: string; truncated: boolean } {
  if (output.length <= maxLength) return { output, truncated: false }
  if (frontAndBack) {
    const halfLength = Math.floor(maxLength / 2)
    return {
      output: `${output.substring(0, halfLength)}\n\n... (output truncated) ...\n\n${output.substring(output.length - halfLength)}`,
      truncated: true,
    }
  }
  return { output: `${output.substring(0, maxLength)}\n\n... (output truncated)`, truncated: true }
}

function stripSchemaArtifacts(value: unknown): unknown {
  if (value === null || typeof value !== "object") return value
  if (Array.isArray(value)) return value.map(stripSchemaArtifacts)
  const { $schema: _schema, default: _default, definitions: _definitions, markdownDescription: _markdown, additionalProperties: _additional, ...rest } =
    value as Record<string, unknown>
  const result: Record<string, unknown> = {}
  for (const [key, child] of Object.entries(rest)) result[key] = stripSchemaArtifacts(child)
  return result
}

/** Draft 2020-12 spells tuple schemas with `prefixItems`, and providers read that version. */
export function convertTupleSchemaToDraft2020_12(value: unknown): unknown {
  if (value === null || typeof value !== "object") return value
  if (Array.isArray(value)) return value.map(convertTupleSchemaToDraft2020_12)
  const record = value as Record<string, unknown>
  const result: Record<string, unknown> = {}
  const isTupleSchema = Array.isArray(record.items)
  for (const [key, child] of Object.entries(record)) {
    if (key === "items" && Array.isArray(child)) {
      result.prefixItems = child.map(convertTupleSchemaToDraft2020_12)
      if (record.additionalItems === false) result.items = false
    } else if (key === "additionalItems") {
      if (isTupleSchema && child !== false) result.items = convertTupleSchemaToDraft2020_12(child)
    } else {
      result[key] = convertTupleSchemaToDraft2020_12(child)
    }
  }
  return result
}

interface AgentToolLike {
  name: string
  parameters: ZodTypeAny
  render: (...args: never[]) => unknown
  execute: (...args: never[]) => Promise<unknown>
  serializeError: (error: unknown) => unknown
  [key: string]: unknown
}

/** Wraps a zod-declared tool into the shape the model sees, with its own span per execution. */
export function createZodAgentTool(toolIdentifier: string, tool: AgentToolLike): Record<string, unknown> {
  const schema = stripSchemaArtifacts(zodToJsonSchema(tool.parameters))
  return {
    toolIdentifier,
    name: tool.name,
    contextType: tool.contextType,
    dynamicToolMetaRole: tool.dynamicToolMetaRole,
    resolveToolCallTelemetry: tool.resolveToolCallTelemetry,
    descriptionGenerator: tool.descriptionGenerator,
    descriptionTokenPartsGenerator: tool.descriptionTokenPartsGenerator,
    parameters: jsonSchema(schema as Parameters<typeof jsonSchema>[0]),
    customToolFormat: tool.customToolFormat,
    prepareSubagent: tool.prepareSubagent,
    render: (ctx: unknown, output: unknown, props: unknown) => (tool.render as (a: unknown, b: unknown, c: unknown) => unknown)(ctx, output, props),
    execute: async (parentCtx: Context, interactionHandler: unknown, argsStream: AsyncIterable<string>, meta: ToolExecutionMetaLike) => {
      using spanContext = createSpan(parentCtx.withName("execute"))
      spanContext.span.setAttribute("tool.name", toolIdentifier)
      return await (tool.execute as (a: Context, b: unknown, c: AsyncIterable<string>, d: unknown) => Promise<unknown>)(
        spanContext.ctx, interactionHandler, argsStream, meta,
      )
    },
    serializeError: (error: unknown) => (tool.serializeError as (value: unknown) => unknown)(error),
  }
}

function parseJsonArgsWithZodSchema(args: string, schema: ZodTypeAny): unknown {
  let parsedJson: unknown
  try {
    parsedJson = JSON.parse(args)
  } catch (error) {
    const message = error instanceof Error ? error.message : "Invalid arguments"
    throw new ToolCallArgParseError(
      `Tool call arguments were not valid JSON (${message}). Re-issue the call with arguments as a single well-formed JSON object.`,
    )
  }
  const parsed = schema.safeParse(parsedJson)
  if (!parsed.success) {
    const messages = parsed.error.errors.map(error => `${error.path.length > 0 ? error.path.join(".") : "argument"}: ${error.message}`)
    throw new ToolCallArgParseError(`Invalid arguments:\n${messages.join("\n")}`)
  }
  return parsed.data
}

/** The kind of call a tool was invoked as, which is all this wrapper reads off it. */
function toolCallCase(value: unknown): string {
  if (value === null || typeof value !== "object") return "unknown"
  const tool = (value as { tool?: { case?: unknown } }).tool
  return typeof tool?.case === "string" ? tool.case : "unknown"
}

/** Collects the streamed arguments, parses them, and only then runs the tool's own execution. */
export const withSafeParsedArgs = (
  parametersSchema: ZodTypeAny | ((meta: ToolExecutionMetaLike) => ZodTypeAny),
  execute: (ctx: Context, interactionHandler: unknown, args: unknown, meta: ToolExecutionMetaLike) => Promise<unknown>,
  initialToolCall: unknown,
  options?: { emitInitialPartialToolCall?: boolean },
) => async (
  ctx: Context,
  interactionHandler: { emitPartialToolCall: (ctx: Context, toolCallId: string, call: unknown) => void },
  argsStream: AsyncIterable<string>,
  meta: ToolExecutionMetaLike,
): Promise<unknown> => {
  if (options?.emitInitialPartialToolCall !== false) interactionHandler.emitPartialToolCall(ctx, meta.toolCallId, initialToolCall)
  let args = ""
  let parsedArgs: unknown
  try {
    for await (const chunk of argsStream) args += chunk
    const toolName = toolCallCase(initialToolCall)
    args = stripMarkerTokensFromArgs({ ctx, args, toolName, strip: needsMarkerTokenStripping(meta) })
    parsedArgs = parseJsonArgsWithZodSchema(args, typeof parametersSchema === "function" ? parametersSchema(meta) : parametersSchema)
  } catch (error) {
    toolArgsParseSuccessRate.histogram(ctx, 0, { tool_name: toolCallCase(initialToolCall) })
    if (error instanceof ToolCallArgParseError) throw error
    throw new ToolCallArgParseError(error instanceof Error ? error.message : "Invalid arguments")
  }
  toolArgsParseSuccessRate.histogram(ctx, 1, { tool_name: toolCallCase(initialToolCall) })
  using coreExecuteSpan = createSpan(ctx.withName("coreExecute"))
  return await execute(coreExecuteSpan.ctx, interactionHandler, parsedArgs, meta)
}

export function resolveTerminalsFolder(value: string | (() => string)): string {
  return typeof value === "function" ? value() : value
}

const CODEX_PROMPT_VERSIONS = ["gpt5-codex", "codex-cloud"]

export function isCodexPromptVersion(version: string): boolean {
  return CODEX_PROMPT_VERSIONS.includes(version)
}

export function createToolCallExecutionTimeoutError({ toolName, executionTimeoutMs }: {
  toolName: string
  executionTimeoutMs: number
}): ToolTimeoutError {
  const message = buildToolCallExecutionTimedOutMessage({ toolName, executionTimeoutMs })
  return new ToolTimeoutError({ clientVisibleErrorMessage: message, modelVisibleErrorMessage: message, error: message })
}

interface TimeoutToolLike {
  name: string
  execute: (...args: never[]) => Promise<unknown>
  [key: string]: unknown
}

interface TimeoutEvent<T extends TimeoutToolLike> {
  ctx: Context
  tool: T
  meta: ToolExecutionMetaLike
  timeoutMs: number
}

/**
 * Runs a tool under a timeout that pauses while the call is suspended — waiting for a person is not
 * the same as being slow — and that measures the remaining time across those pauses.
 */
export function wrapToolWithTimeout<T extends TimeoutToolLike>(tool: T, options: {
  timeoutMs: number
  onTimeout?: (event: TimeoutEvent<T>) => unknown
  createTimeoutError?: (event: TimeoutEvent<T>) => unknown
}): T {
  const timeoutMs = options.timeoutMs
  const createTimeoutError = options.createTimeoutError ??
    ((event: TimeoutEvent<T>) => new Error(`Tool ${event.tool.name} timed out after ${event.timeoutMs} ms`))
  return {
    ...tool,
    execute: async (parentCtx: Context, interactionHandler: unknown, argsStream: AsyncIterable<string>, meta: ToolExecutionMetaLike) => {
      const parentSuspension = parentCtx.get(toolExecutionTimeoutSuspensionKey)
      const [execCtx, cancelExec] = parentCtx.withCancel()
      let finished = false
      let remainingMs = timeoutMs
      let armedAtMs: number | undefined
      let timer: NodeJS.Timeout | undefined
      let suspendCount = 0

      const disarm = (): void => {
        if (timer !== undefined) {
          clearTimeout(timer)
          timer = undefined
        }
        if (armedAtMs !== undefined) {
          remainingMs = Math.max(0, remainingMs - (Date.now() - armedAtMs))
          armedAtMs = undefined
        }
      }
      const arm = (): void => {
        if (finished || suspendCount > 0 || timer !== undefined) return
        armedAtMs = Date.now()
        timer = setTimeout(() => {
          timer = undefined
          armedAtMs = undefined
          cancelExec(new Error("context deadline exceeded"))
        }, remainingMs)
      }

      const suspension: ToolExecutionTimeoutSuspension = {
        suspend: () => {
          const resumeParent = parentSuspension?.suspend()
          suspendCount += 1
          disarm()
          let resumed = false
          return () => {
            if (resumed) return
            resumed = true
            suspendCount -= 1
            arm()
            resumeParent?.()
          }
        },
      }
      const timeoutCtx = execCtx.with(toolExecutionTimeoutSuspensionKey, suspension)
      const timeoutPromise = new Promise<never>((_resolve, reject) => {
        execCtx.signal.addEventListener("abort", () => {
          if (finished) return
          const event = { ctx: parentCtx, tool, meta, timeoutMs }
          if (options.onTimeout !== undefined) void Promise.resolve(options.onTimeout(event)).catch(() => {})
          reject(createTimeoutError(event))
        }, { once: true })
      })
      arm()
      try {
        return await Promise.race([
          (tool.execute as (a: Context, b: unknown, c: AsyncIterable<string>, d: unknown) => Promise<unknown>)(
            timeoutCtx, interactionHandler, argsStream, meta,
          ),
          timeoutPromise,
        ])
      } finally {
        finished = true
        disarm()
        cancelExec()
      }
    },
  } as T
}

export {
  CustomToolCallError,
  RetryableToolEnvironmentOrchestrationError,
  RetryableToolOrchestrationError,
  ToolCallAbortedError,
  ToolCallArgParseError,
  ToolCallError,
  ToolErrorClassification,
  ToolTimeoutError,
}
