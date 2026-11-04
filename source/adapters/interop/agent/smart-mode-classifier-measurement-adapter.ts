import {
  SmartModeClassifierDecision,
  type SmartModeClassifierArgs,
  type SmartModeClassifierResult,
} from "../proto/generated/agent/v1/smart_mode_classifier_exec_pb.ts";
import type { Context } from "../../../packages/context/context.ts";
import type { Executor } from "../../../packages/agent-exec/executor-resources.ts";
import {
  executeSmartModeClassifierWithMeasurement as executeMeasurementPolicy,
  type ClassifierDecisionLabel,
  type ClassifierResultObservation,
  type SmartModeClassifierMeasurementOptions,
  type SmartModeClassifierMeasurementProjection,
} from "../../../packages/agent/utils/smart-mode-classifier-measurement.ts";
import { parseSmartModeClassifierFailureMetadata } from "../../../packages/agent/utils/smart-mode-error-metadata.ts";

const measurementProjection: SmartModeClassifierMeasurementProjection<
  SmartModeClassifierArgs,
  SmartModeClassifierResult
> = {
  describeCall(args) {
    return {
      actionKind: actionKindFromWire(args.target?.action),
      surfaceLabel: surfaceLabelFromWireArguments(args.target?.arguments?.toJson()),
      hasTarget: args.target !== undefined,
      hasTargetArguments: args.target?.arguments !== undefined,
      toolCallId: args.toolCallId,
    };
  },
  describeResult: describeClassifierResult,
};

function actionKindFromWire(action: string | undefined): string {
  const normalized = action?.trim().toLowerCase();
  if (normalized == null || normalized.length === 0) return "unknown";
  switch (normalized) {
    case "shell":
    case "mcp":
    case "slate_computer":
    case "web_fetch":
    case "fetch_mcp_resource":
      return normalized;
    default:
      return "other";
  }
}

function surfaceLabelFromWireArguments(value: unknown): string | undefined {
  if (value == null || typeof value !== "object" || Array.isArray(value)) return undefined;
  const surface = (value as Record<string, unknown>).execution_surface;
  return surface === "host_machine" || surface === "isolated_box" ? surface : undefined;
}

function decisionLabel(decision: SmartModeClassifierDecision): ClassifierDecisionLabel {
  switch (decision) {
    case SmartModeClassifierDecision.ALLOW:
      return "allow";
    case SmartModeClassifierDecision.BLOCK:
      return "block";
    case SmartModeClassifierDecision.UNSPECIFIED:
      return "unspecified";
    default:
      return "unknown";
  }
}

function describeClassifierResult(result: SmartModeClassifierResult): ClassifierResultObservation {
  switch (result.result.case) {
    case "success":
      return {
        kind: "decision",
        decision: decisionLabel(result.result.value.decision),
        hasReason: result.result.value.blockReason !== undefined,
      };
    case "error": {
      const metadata = parseSmartModeClassifierFailureMetadata(result.result.value.error);
      return {
        kind: "error",
        failureReason: metadata?.failureReason,
        retryable: metadata?.retryable,
      };
    }
    default:
      return { kind: "missing" };
  }
}

/** Executes the generated classifier exchange through Slate's retry and measurement policy. */
export function executeSmartModeClassifierWithMeasurement(
  ctx: Context,
  executor: Executor<SmartModeClassifierArgs, SmartModeClassifierResult>,
  args: SmartModeClassifierArgs,
  mode = "enforce",
  workspacePaths?: readonly string[],
  options?: SmartModeClassifierMeasurementOptions,
): Promise<SmartModeClassifierResult> {
  return executeMeasurementPolicy(
    ctx,
    executor,
    args,
    measurementProjection,
    mode,
    workspacePaths,
    options,
  );
}
