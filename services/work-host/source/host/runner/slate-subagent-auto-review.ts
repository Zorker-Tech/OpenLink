/**
 * Reviewing what a subagent did on an agent's behalf.
 *
 * What the subagent was asked for and what it came back with are put side by side, so a review can tell work that was
 * done from work that was claimed.
 */
import {
  fingerprintSlateAutoReviewTarget,
  type SlateAutoReviewController,
  type SlateAutoReviewExpiryPolicy,
  type SlateAutoReviewMode,
} from "./slate-auto-review.ts";
import type { AutoReviewClassifierDecision } from "./slate-auto-review-classifier-run.ts";
import { buildProjectPermissionsContext } from "./slate-computer-auto-review.ts";
import { summarizeSlateSubagentAction } from "./slate-auto-review-summaries.ts";
import { createSlateAutoReviewRiskTarget, type SlateAutoReviewRiskTarget } from "./auto-review-classifier-contracts.ts";

export const SLATE_SUBAGENT_CLASSIFIER_TARGET_ACTION = "slate_subagent";
export const SLATE_SUBAGENT_CLASSIFIER_ERROR_REASON =
  "An error occurred while reviewing this task. Please review manually.";

export interface SubagentReviewTarget {
  readonly action: "launch" | "steer";
  readonly prompt: string;
  readonly subagentType?: string;
  readonly subagentAgentId?: string;
  readonly readonly?: boolean;
  readonly resume?: boolean;
}

export interface InstructionPermissions {
  readonly allowInstructions?: readonly string[];
  readonly blockInstructions?: readonly string[];
}

export function buildSlateSubagentLaunchReviewTarget(input: {
  readonly prompt: string;
  readonly subagentType?: string;
  readonly readonly?: boolean;
  readonly resume?: boolean;
}): SubagentReviewTarget | undefined {
  const prompt = input.prompt.trim();
  if (prompt.length === 0) return undefined;
  return {
    action: "launch",
    prompt,
    ...(input.subagentType != null && input.subagentType.length > 0
      ? { subagentType: input.subagentType }
      : {}),
    ...(input.readonly == null ? {} : { readonly: input.readonly }),
    ...(input.resume == null ? {} : { resume: input.resume }),
  };
}

export function buildSlateSubagentSteerReviewTarget(input: {
  readonly message: string;
  readonly subagentAgentId: string;
  readonly subagentType?: string;
}): SubagentReviewTarget | undefined {
  const prompt = input.message.trim();
  if (prompt.length === 0) return undefined;
  return {
    action: "steer",
    prompt,
    subagentAgentId: input.subagentAgentId,
    ...(input.subagentType != null && input.subagentType.length > 0
      ? { subagentType: input.subagentType }
      : {}),
  };
}

export function buildSlateSubagentRiskTarget(input: {
  readonly target: SubagentReviewTarget;
  readonly personalInstructions?: InstructionPermissions;
  readonly userAutoRunInstructions?: InstructionPermissions;
  readonly projectAutoRunInstructions?: InstructionPermissions;
}): SlateAutoReviewRiskTarget {
  const { target } = input;
  const argumentsRecord = JSON.parse(JSON.stringify({
      surface: "subagent",
      action: target.action,
      prompt: target.prompt,
      subagent_type: target.subagentType,
      subagent_agent_id: target.subagentAgentId,
      readonly: target.readonly,
      resume: target.resume,
      project_permissions: buildProjectPermissionsContext(input),
    })) as Record<string, unknown>;
  return createSlateAutoReviewRiskTarget(SLATE_SUBAGENT_CLASSIFIER_TARGET_ACTION, argumentsRecord);
}

export interface SubagentReviewOptions<Context> {
  readonly mode: SlateAutoReviewMode;
  readonly agentId: string;
  readonly autoReviewController?: Pick<SlateAutoReviewController, "requestApproval">;
  readonly personalInstructions?: InstructionPermissions;
  readonly userAutoRunInstructions?: InstructionPermissions;
  readonly projectAutoRunInstructions?: InstructionPermissions;
  readonly getApprovalExpiryPolicy?: () => SlateAutoReviewExpiryPolicy;
  classify(
    context: Context,
    target: SubagentReviewTarget,
    mode: "shadow" | "enforce",
    toolCallId: string,
  ): Promise<AutoReviewClassifierDecision>;
  reportShadowFailure?(failure: unknown): void;
  suspendToolExecutionTimeout?<T>(context: Context, operation: () => Promise<T>): Promise<T>;
}

const CANCELLED_REVIEW = {
  allowed: false,
  reason: "The task was cancelled.",
} as const;

export async function reviewSlateSubagentAction<Context>(input: {
  readonly ctx: Context;
  readonly target: SubagentReviewTarget;
  readonly options: SubagentReviewOptions<Context>;
  readonly toolCallId: string;
  readonly signal?: AbortSignal;
}): Promise<{ readonly allowed: boolean; readonly reason?: string }> {
  const { ctx, target, options, toolCallId } = input;
  if (options.mode === "off") return { allowed: true };
  if (options.mode === "shadow") {
    void options.classify(ctx, target, "shadow", toolCallId)
      .catch((failure: unknown) => options.reportShadowFailure?.(failure));
    return { allowed: true };
  }
  const isCancelled = () => input.signal?.aborted === true;
  if (isCancelled()) return CANCELLED_REVIEW;
  const classifierDecision = await options.classify(ctx, target, "enforce", toolCallId);
  if (isCancelled()) return CANCELLED_REVIEW;
  if (classifierDecision.kind === "allow") return { allowed: true };
  const approvalController = options.autoReviewController;
  if (classifierDecision.kind !== "block" || approvalController == null) {
    return { allowed: false, reason: classifierDecision.reason };
  }
  const approvalRequest = () => approvalController.requestApproval({
    agentId: options.agentId,
    surface: "subagent",
    fingerprint: fingerprintSlateAutoReviewTarget({
      action: target.action,
      prompt: target.prompt,
      subagentType: target.subagentType,
      subagentAgentId: target.subagentAgentId,
      readonly: target.readonly,
      resume: target.resume,
    }),
    reason: classifierDecision.reason,
    summary: summarizeSlateSubagentAction({ action: target.action, prompt: target.prompt }),
    ...(classifierDecision.proposedRule == null ? {} : { proposedRule: classifierDecision.proposedRule }),
    ...(input.signal == null ? {} : { signal: input.signal }),
    ...(options.getApprovalExpiryPolicy == null
      ? {}
      : { expiryPolicy: options.getApprovalExpiryPolicy() }),
  });
  const approvalOutcome = options.suspendToolExecutionTimeout == null
    ? await approvalRequest()
    : await options.suspendToolExecutionTimeout(ctx, approvalRequest);
  if (isCancelled()) return CANCELLED_REVIEW;
  return approvalOutcome.approved
    ? { allowed: true }
    : { allowed: false, reason: approvalOutcome.reason ?? classifierDecision.reason };
}
