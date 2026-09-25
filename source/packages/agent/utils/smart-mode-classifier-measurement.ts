/**
 * Asking the classifier whether an action may run, and reporting what it said.
 *
 * The classifier is a model call, which means it can be slow, it can fail, and it can answer with
 * nothing useful — and it stands between the user and an action, so all three have to be handled
 * rather than surfaced. That is what this does around one call: a timeout, and a retry that only
 * happens for answers that are worth retrying (an error, a missing result, or a decision that was not
 * made) rather than for a decision that was.
 *
 * What it reports is deliberately about the decision and not about the action: which surface the action
 * would run on, how long the call took, how many attempts it took, whether a reason came with the
 * decision, and why it failed when it did. The classifier's own text is never part of it — the reason a
 * call failed is a category, not a message.
 *
 * The attempt's own context is what the classifier sees, carrying which attempt it is, the mode it is
 * being asked in, and the workspace it is being asked about, so anything the classifier reports can be
 * attributed to the attempt rather than to the turn. A cancellation is not a failure and is not
 * retried: the user stopped it.
 */

import type { Context } from "../../context/context.ts"
import { createKey } from "../../context/context.ts"
import { createLogger } from "../../context/logging.ts"
import type { Executor } from "../../agent-exec/executor-resources.ts"
import {
  SmartModeClassifierDecision,
  type SmartModeClassifierArgs,
  type SmartModeClassifierResult,
} from "../../proto/generated/agent/v1/smart_mode_classifier_exec_pb.ts"
import { withTimeout } from "../../utils/promise-tools.ts"
import { getAgentEventTracker } from "./event-tracking.ts"
import { parseSmartModeClassifierFailureMetadata } from "./smart-mode-error-metadata.ts"

const logger = createLogger("agent/smart-mode-classifier")

const CLASSIFIER_TIMEOUT_MS = 10_000
/** A developer's machine is running the workspace and the classifier at once; the limit is looser there. */
const LOCAL_DEVELOPMENT_TIMEOUT_MULTIPLIER = 3
const MAX_TOTAL_ATTEMPTS = 2

export const smartModeClassifierAttemptIndexKey = createKey<number | undefined>(Symbol("smartModeClassifierAttemptIndex"), undefined)
export const smartModeClassifierModeKey = createKey<string | undefined>(Symbol("smartModeClassifierMode"), undefined)
export const smartModeClassifierWorkspacePathsKey = createKey<readonly string[] | undefined>(Symbol("smartModeClassifierWorkspacePaths"), undefined)

function getClassifierTimeoutMs(): number {
  if (typeof process !== "undefined" && process.env.NODE_ENV === "development") {
    return CLASSIFIER_TIMEOUT_MS * LOCAL_DEVELOPMENT_TIMEOUT_MULTIPLIER
  }
  return CLASSIFIER_TIMEOUT_MS
}

export interface SmartModeClassifierMeasurementOptions {
  readonly maxAttempts?: number | undefined
  readonly suppressToolCallIdLogging?: boolean | undefined
}

export async function executeSmartModeClassifierWithMeasurement(
  ctx: Context,
  executor: Executor<SmartModeClassifierArgs, SmartModeClassifierResult>,
  args: SmartModeClassifierArgs,
  mode: string = "enforce",
  workspacePaths?: readonly string[],
  options?: SmartModeClassifierMeasurementOptions,
): Promise<SmartModeClassifierResult> {
  const overallStartTime = performance.now()
  const actionKind = normalizeClassifierActionKind(args.target?.action)
  const surfaceLabel = getClassifierSurfaceLabel(args)
  const maxAttempts = Math.max(1, options?.maxAttempts ?? MAX_TOTAL_ATTEMPTS)
  const toolCallId = options?.suppressToolCallIdLogging === true ? undefined : args.toolCallId

  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    const timeoutMs = getClassifierTimeoutMs()
    const timeoutMessage = `Smart Mode classifier timed out after ${timeoutMs}ms`
    const attemptIndex = attempt - 1
    const [cancelableAttemptCtx, cancelAttempt] = ctx.withCancel()
    const attemptCtx = cancelableAttemptCtx
      .with(smartModeClassifierAttemptIndexKey, attemptIndex)
      .with(smartModeClassifierModeKey, mode)
      .with(smartModeClassifierWorkspacePathsKey, workspacePaths)
    recordClassifierStart(ctx, {
      mode,
      actionKind,
      surfaceLabel,
      timeoutMs,
      hasTarget: args.target !== undefined,
      hasTargetArguments: args.target?.arguments !== undefined,
    }, toolCallId)
    try {
      const result = await withTimeout(
        Promise.resolve().then(() => executor.execute(attemptCtx, args)),
        timeoutMs,
        timeoutMessage,
      )
      const classified = classifyClassifierResult(result)
      // A decision is an answer; only the absence of one is worth asking again for.
      if (isRetryableClassifierFailure(classified) && attempt < maxAttempts) continue
      recordClassifierCall(ctx, {
        mode,
        actionKind,
        surfaceLabel,
        ...classified,
        latencyMs: elapsedMs(overallStartTime),
        retryCount: attempt - 1,
      }, toolCallId)
      return result
    } catch (error: unknown) {
      if (error instanceof Error && error.name === "AbortError") {
        recordClassifierException(ctx, {
          mode,
          actionKind,
          surfaceLabel,
          latencyMs: elapsedMs(overallStartTime),
          retryCount: attempt - 1,
        }, toolCallId)
        throw error
      }
      const failureReason = classifyClassifierException(error)
      // The attempt is over either way; cancelling its context is what stops the work behind it.
      if (failureReason === "timeout_exception") cancelAttempt(new Error(timeoutMessage))
      if (attempt < maxAttempts) continue
      recordClassifierException(ctx, {
        mode,
        actionKind,
        surfaceLabel,
        latencyMs: elapsedMs(overallStartTime),
        retryCount: attempt - 1,
        failureReason,
      }, toolCallId)
      throw error
    }
  }
  throw new Error("Smart Mode classifier retry loop exited unexpectedly")
}

/** The actions worth telling apart in the measurement; everything else is just "other". */
function normalizeClassifierActionKind(action: string | undefined): string {
  const normalizedAction = action?.trim().toLowerCase()
  if (normalizedAction === undefined || normalizedAction.length === 0) return "unknown"
  if (
    normalizedAction === "shell" ||
    normalizedAction === "mcp" ||
    normalizedAction === "slate_computer" ||
    normalizedAction === "web_fetch" ||
    normalizedAction === "fetch_mcp_resource"
  ) {
    return normalizedAction
  }
  return "other"
}

/** Which machine the action would run on, when the classifier was told. */
function getClassifierSurfaceLabel(args: SmartModeClassifierArgs): string | undefined {
  const json = args.target?.arguments?.toJson()
  if (json === null || Array.isArray(json) || typeof json !== "object") return undefined
  const surface = (json as Record<string, unknown>).execution_surface
  return surface === "host_machine" || surface === "isolated_box" ? surface : undefined
}

interface ClassifiedClassifierResult {
  readonly outcome: "allow" | "block" | "error" | "missing"
  readonly decision: "allow" | "block" | "unspecified" | "unknown"
  readonly hasReason: boolean
  readonly failureReason?: string
  readonly retryable?: boolean
}

function classifyClassifierResult(result: SmartModeClassifierResult): ClassifiedClassifierResult {
  switch (result.result.case) {
    case "success": {
      const decision = classifierDecisionToLabel(result.result.value.decision)
      return {
        outcome: classifierDecisionToOutcome(result.result.value.decision),
        decision,
        hasReason: result.result.value.blockReason !== undefined,
        ...getDecisionFailureMetadata(decision),
      }
    }
    case "error": {
      // The classifier's own text says whether asking again could help.
      const metadata = parseSmartModeClassifierFailureMetadata(result.result.value.error)
      return {
        outcome: "error",
        decision: "unknown",
        hasReason: false,
        failureReason: metadata?.failureReason ?? "classifier_result_error",
        retryable: metadata?.retryable ?? true,
      }
    }
    default:
      return { outcome: "missing", decision: "unknown", hasReason: false, failureReason: "missing_result", retryable: true }
  }
}

function classifierDecisionToOutcome(decision: SmartModeClassifierDecision): "allow" | "block" | "missing" {
  switch (decision) {
    case SmartModeClassifierDecision.ALLOW:
      return "allow"
    case SmartModeClassifierDecision.BLOCK:
      return "block"
    case SmartModeClassifierDecision.UNSPECIFIED:
      return "missing"
    default:
      return "missing"
  }
}

function classifierDecisionToLabel(decision: SmartModeClassifierDecision): "allow" | "block" | "unspecified" | "unknown" {
  switch (decision) {
    case SmartModeClassifierDecision.ALLOW:
      return "allow"
    case SmartModeClassifierDecision.BLOCK:
      return "block"
    case SmartModeClassifierDecision.UNSPECIFIED:
      return "unspecified"
    default:
      return "unknown"
  }
}

/** A decision is final; not having made one is the only thing worth another attempt. */
function getDecisionFailureMetadata(
  decision: ClassifiedClassifierResult["decision"],
): { readonly failureReason?: string; readonly retryable?: boolean } {
  switch (decision) {
    case "allow":
    case "block":
      return { retryable: false }
    case "unspecified":
      return { failureReason: "unspecified_decision", retryable: true }
    case "unknown":
      return { failureReason: "unknown_decision", retryable: true }
  }
}

function isRetryableClassifierFailure(result: ClassifiedClassifierResult): boolean {
  if (result.outcome === "allow" || result.outcome === "block") return false
  return result.retryable ?? true
}

function classifyClassifierException(error: unknown): string {
  if (error instanceof Error && (error.name === "TimeoutError" || error.message.includes("Smart Mode classifier timed out"))) {
    return "timeout_exception"
  }
  return "unknown_exception"
}

function elapsedMs(startTime: number): number {
  return Math.max(0, Math.round(performance.now() - startTime))
}

interface ClassifierCallMeasurement {
  readonly mode: string
  readonly actionKind: string
  readonly surfaceLabel: string | undefined
  readonly outcome: string
  readonly decision: string
  readonly hasReason: boolean
  readonly latencyMs: number
  readonly retryCount: number
  readonly failureReason?: string
  readonly retryable?: boolean
}

interface ClassifierStartMeasurement {
  readonly mode: string
  readonly actionKind: string
  readonly surfaceLabel: string | undefined
  readonly timeoutMs: number
  readonly hasTarget: boolean
  readonly hasTargetArguments: boolean
}

interface ClassifierExceptionMeasurement {
  readonly mode: string
  readonly actionKind: string
  readonly surfaceLabel: string | undefined
  readonly latencyMs: number
  readonly retryCount: number
  readonly failureReason?: string
}

/** Reporting a classifier call must never be the reason a call fails, so both sinks are guarded. */
function recordClassifierCall(ctx: Context, options: ClassifierCallMeasurement, toolCallId: string | undefined): void {
  try {
    logger.info(ctx, "smart_mode.classifier_call", {
      mode: options.mode,
      actionKind: options.actionKind,
      surfaceLabel: options.surfaceLabel,
      outcome: options.outcome,
      decision: options.decision,
      hasReason: options.hasReason,
      latencyMs: options.latencyMs,
      retryCount: options.retryCount,
      failureReason: options.failureReason,
      ...(toolCallId !== undefined ? { toolCallId } : {}),
    })
  } catch {
  }
  try {
    getAgentEventTracker(ctx).trackSmartModeClassifierCall(ctx, options)
  } catch {
  }
}

function recordClassifierStart(ctx: Context, options: ClassifierStartMeasurement, toolCallId: string | undefined): void {
  try {
    logger.info(ctx, "smart_mode.classifier_call.started", {
      mode: options.mode,
      actionKind: options.actionKind,
      surfaceLabel: options.surfaceLabel,
      timeoutMs: options.timeoutMs,
      hasTarget: options.hasTarget,
      hasTargetArguments: options.hasTargetArguments,
      ...(toolCallId !== undefined ? { toolCallId } : {}),
    })
  } catch {
  }
}

function recordClassifierException(ctx: Context, options: ClassifierExceptionMeasurement, toolCallId: string | undefined): void {
  recordClassifierCall(ctx, {
    ...options,
    outcome: "exception",
    decision: "unknown",
    hasReason: false,
  }, toolCallId)
}
