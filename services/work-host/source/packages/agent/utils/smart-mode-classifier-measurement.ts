/** Retry, timeout and reporting policy around one Smart Mode classification call. */

import type { Context } from "../../context/context.ts";
import { createKey } from "../../context/context.ts";
import { createLogger } from "../../context/logging.ts";
import type { Executor } from "../../agent-exec/executor-resources.ts";
import { withTimeout } from "../../utils/promise-tools.ts";
import { getAgentEventTracker } from "./event-tracking.ts";

const logger = createLogger("agent/smart-mode-classifier");
const CLASSIFICATION_TIMEOUT_MS = 10_000;
const DEVELOPMENT_TIMEOUT_MULTIPLIER = 3;
const DEFAULT_ATTEMPT_LIMIT = 2;

export const smartModeClassifierAttemptIndexKey = createKey<number | undefined>(Symbol("smartModeClassifierAttemptIndex"), undefined);
export const smartModeClassifierModeKey = createKey<string | undefined>(Symbol("smartModeClassifierMode"), undefined);
export const smartModeClassifierWorkspacePathsKey = createKey<readonly string[] | undefined>(Symbol("smartModeClassifierWorkspacePaths"), undefined);

export interface SmartModeClassifierMeasurementOptions {
  readonly maxAttempts?: number | undefined;
  readonly suppressToolCallIdLogging?: boolean | undefined;
}

export interface SmartModeClassifierCallObservation {
  readonly actionKind: string;
  readonly surfaceLabel: string | undefined;
  readonly hasTarget: boolean;
  readonly hasTargetArguments: boolean;
  readonly toolCallId: string | undefined;
}

export type ClassifierDecisionLabel = "allow" | "block" | "unspecified" | "unknown";

/** The adapter's small, Slate-owned account of what the remote classifier answered. */
export interface ClassifierResultObservation {
  readonly kind: "decision" | "error" | "missing";
  readonly decision?: ClassifierDecisionLabel | undefined;
  readonly hasReason?: boolean | undefined;
  readonly failureReason?: string | undefined;
  readonly retryable?: boolean | undefined;
}

export interface SmartModeClassifierMeasurementProjection<Arguments, Result> {
  describeCall(args: Arguments): SmartModeClassifierCallObservation;
  describeResult(result: Result): ClassifierResultObservation;
}

interface ClassifierCallMeasurement {
  readonly mode: string;
  readonly actionKind: string;
  readonly surfaceLabel: string | undefined;
  readonly outcome: "allow" | "block" | "error" | "missing" | "exception";
  readonly decision: ClassifierDecisionLabel;
  readonly hasReason: boolean;
  readonly latencyMs: number;
  readonly retryCount: number;
  readonly failureReason?: string | undefined;
  readonly retryable?: boolean | undefined;
}

interface ClassifierStartMeasurement {
  readonly mode: string;
  readonly actionKind: string;
  readonly surfaceLabel: string | undefined;
  readonly timeoutMs: number;
  readonly hasTarget: boolean;
  readonly hasTargetArguments: boolean;
}

interface ClassifierExceptionMeasurement {
  readonly mode: string;
  readonly actionKind: string;
  readonly surfaceLabel: string | undefined;
  readonly latencyMs: number;
  readonly retryCount: number;
  readonly failureReason?: string | undefined;
}

interface ClassifiedResult extends Omit<ClassifierCallMeasurement, "mode" | "actionKind" | "surfaceLabel" | "latencyMs" | "retryCount"> {}

function timeoutForCurrentEnvironment(): number {
  return typeof process !== "undefined" && process.env.NODE_ENV === "development"
    ? CLASSIFICATION_TIMEOUT_MS * DEVELOPMENT_TIMEOUT_MULTIPLIER
    : CLASSIFICATION_TIMEOUT_MS;
}

function classifyObservation(observation: ClassifierResultObservation): ClassifiedResult {
  if (observation.kind === "error") {
    return {
      outcome: "error",
      decision: "unknown",
      hasReason: false,
      failureReason: observation.failureReason ?? "classifier_result_error",
      retryable: observation.retryable ?? true,
    };
  }
  if (observation.kind === "missing") {
    return {
      outcome: "missing",
      decision: "unknown",
      hasReason: false,
      failureReason: "missing_result",
      retryable: true,
    };
  }

  const decision = observation.decision ?? "unknown";
  if (decision === "allow" || decision === "block") {
    return {
      outcome: decision,
      decision,
      hasReason: observation.hasReason === true,
      retryable: false,
    };
  }
  return {
    outcome: "missing",
    decision,
    hasReason: observation.hasReason === true,
    failureReason: decision === "unspecified" ? "unspecified_decision" : "unknown_decision",
    retryable: true,
  };
}

function isRetryable(result: ClassifiedResult): boolean {
  if (result.outcome === "allow" || result.outcome === "block") return false;
  return result.retryable ?? true;
}

function exceptionReason(error: unknown): string {
  if (error instanceof Error && (error.name === "TimeoutError" || error.message.includes("Smart Mode classifier timed out"))) {
    return "timeout_exception";
  }
  return "unknown_exception";
}

function elapsedSince(startedAt: number): number {
  return Math.max(0, Math.round(performance.now() - startedAt));
}

/** Telemetry sinks are optional; a broken one must not change the action's classifier result. */
function reportResult(ctx: Context, measurement: ClassifierCallMeasurement, toolCallId: string | undefined): void {
  try {
    logger.info(ctx, "smart_mode.classifier_call", {
      mode: measurement.mode,
      actionKind: measurement.actionKind,
      surfaceLabel: measurement.surfaceLabel,
      outcome: measurement.outcome,
      decision: measurement.decision,
      hasReason: measurement.hasReason,
      latencyMs: measurement.latencyMs,
      retryCount: measurement.retryCount,
      failureReason: measurement.failureReason,
      ...(toolCallId === undefined ? {} : { toolCallId }),
    });
  } catch {}
  try {
    getAgentEventTracker(ctx).trackSmartModeClassifierCall(ctx, measurement);
  } catch {}
}

function reportAttemptStart(ctx: Context, measurement: ClassifierStartMeasurement, toolCallId: string | undefined): void {
  try {
    logger.info(ctx, "smart_mode.classifier_call.started", {
      mode: measurement.mode,
      actionKind: measurement.actionKind,
      surfaceLabel: measurement.surfaceLabel,
      timeoutMs: measurement.timeoutMs,
      hasTarget: measurement.hasTarget,
      hasTargetArguments: measurement.hasTargetArguments,
      ...(toolCallId === undefined ? {} : { toolCallId }),
    });
  } catch {}
}

function reportException(ctx: Context, measurement: ClassifierExceptionMeasurement, toolCallId: string | undefined): void {
  reportResult(ctx, {
    ...measurement,
    outcome: "exception",
    decision: "unknown",
    hasReason: false,
  }, toolCallId);
}

/** Runs one or more attempts while keeping result interpretation in the caller's interop projection. */
export async function executeSmartModeClassifierWithMeasurement<Arguments, Result>(
  ctx: Context,
  executor: Executor<Arguments, Result>,
  args: Arguments,
  projection: SmartModeClassifierMeasurementProjection<Arguments, Result>,
  mode = "enforce",
  workspacePaths?: readonly string[],
  options?: SmartModeClassifierMeasurementOptions,
): Promise<Result> {
  const startedAt = performance.now();
  const call = projection.describeCall(args);
  const actionKind = call.actionKind;
  const surfaceLabel = call.surfaceLabel;
  const attemptLimit = Math.max(1, options?.maxAttempts ?? DEFAULT_ATTEMPT_LIMIT);
  const toolCallId = options?.suppressToolCallIdLogging === true ? undefined : call.toolCallId;

  for (let attemptNumber = 1; attemptNumber <= attemptLimit; attemptNumber += 1) {
    const timeoutMs = timeoutForCurrentEnvironment();
    const timeoutMessage = `Smart Mode classifier timed out after ${timeoutMs}ms`;
    const attemptIndex = attemptNumber - 1;
    const [cancelableContext, cancelAttempt] = ctx.withCancel();
    const attemptContext = cancelableContext
      .with(smartModeClassifierAttemptIndexKey, attemptIndex)
      .with(smartModeClassifierModeKey, mode)
      .with(smartModeClassifierWorkspacePathsKey, workspacePaths);

    reportAttemptStart(ctx, {
      mode,
      actionKind,
      surfaceLabel,
      timeoutMs,
      hasTarget: call.hasTarget,
      hasTargetArguments: call.hasTargetArguments,
    }, toolCallId);

    try {
      const result = await withTimeout(
        Promise.resolve().then(() => executor.execute(attemptContext, args)),
        timeoutMs,
        timeoutMessage,
      );
      const classified = classifyObservation(projection.describeResult(result));
      if (isRetryable(classified) && attemptNumber < attemptLimit) continue;
      reportResult(ctx, {
        mode,
        actionKind,
        surfaceLabel,
        ...classified,
        latencyMs: elapsedSince(startedAt),
        retryCount: attemptNumber - 1,
      }, toolCallId);
      return result;
    } catch (error: unknown) {
      if (error instanceof Error && error.name === "AbortError") {
        reportException(ctx, {
          mode,
          actionKind,
          surfaceLabel,
          latencyMs: elapsedSince(startedAt),
          retryCount: attemptNumber - 1,
        }, toolCallId);
        throw error;
      }
      const failureReason = exceptionReason(error);
      if (failureReason === "timeout_exception") cancelAttempt(new Error(timeoutMessage));
      if (attemptNumber < attemptLimit) continue;
      reportException(ctx, {
        mode,
        actionKind,
        surfaceLabel,
        latencyMs: elapsedSince(startedAt),
        retryCount: attemptNumber - 1,
        failureReason,
      }, toolCallId);
      throw error;
    }
  }

  throw new Error("Smart Mode classifier attempt policy ended without a result");
}
