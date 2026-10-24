/**
 * Reviewing what an automation did.
 *
 * A run of an automation is described by what woke it and what it changed, so a review can judge a change that happened
 * without anyone present.
 */
import { Struct } from "@bufbuild/protobuf";
import { describeTrigger } from "../../shared/automation-schedule.ts";
import { triggerSchedule, type AutomationTrigger } from "../../shared/automations.ts";
import { serializeStoredTrigger } from "../automations/automation-trigger.ts";
import { SmartModeRiskTarget } from "../../packages/proto/generated/agent/v1/smart_mode_classifier_exec_pb.ts";
import {
  fingerprintSlateAutoReviewTarget,
  type SlateAutoReviewController,
  type SlateAutoReviewExpiryPolicy,
  type SlateAutoReviewMode,
} from "./slate-auto-review.ts";
import type { AutoReviewClassifierDecision } from "./slate-auto-review-classifier-run.ts";
import { summarizeSlateAutomationWriteAction } from "./slate-auto-review-summaries.ts";
import { buildProjectPermissionsContext } from "./slate-computer-auto-review.ts";
import type { InstructionPermissions } from "./slate-subagent-auto-review.ts";

export const SLATE_AUTOMATION_WRITE_CLASSIFIER_TARGET_ACTION = "slate_automation_write";
export const SLATE_AUTOMATION_WRITE_CLASSIFIER_ERROR_REASON =
  "An error occurred while reviewing this routine. Please review manually.";

export interface AutomationReference {
  readonly id: string;
  readonly name: string;
  readonly body?: string;
  readonly prompt?: string;
}

export interface AutomationWriteTarget {
  readonly operation: string;
  readonly id: string;
  readonly spec: {
    readonly name: string;
    readonly prompt: string;
    readonly trigger: AutomationTrigger;
    readonly isEnabled: boolean;
  };
  readonly referencedWorkflows?: readonly AutomationReference[];
  readonly referencingRoutines?: readonly AutomationReference[];
}

interface AutomationRiskArgs {
  readonly target: AutomationWriteTarget;
  readonly personalInstructions?: InstructionPermissions;
  readonly userAutoRunInstructions?: InstructionPermissions;
  readonly projectAutoRunInstructions?: InstructionPermissions;
}

/** The classifier sees the routine exactly as it would be stored, plus who references it. */
function automationArgumentsRecord(input: AutomationRiskArgs): unknown {
  const { operation, id, spec, referencedWorkflows, referencingRoutines } = input.target;
  return JSON.parse(JSON.stringify({
    surface: "automation_write",
    operation,
    automation_id: id,
    name: spec.name,
    prompt: spec.prompt,
    trigger: serializeStoredTrigger(spec.trigger),
    schedule: triggerSchedule(spec.trigger) ?? undefined,
    trigger_description: describeTrigger(spec.trigger),
    enabled: spec.isEnabled,
    referenced_workflows: referencedWorkflows?.map((workflow) => ({
      id: workflow.id,
      name: workflow.name,
      body: workflow.body,
    })) ?? [],
    referencing_routines: referencingRoutines?.map((routine) => ({
      id: routine.id,
      name: routine.name,
      prompt: routine.prompt,
    })) ?? [],
    project_permissions: buildProjectPermissionsContext(input),
  }));
}

export function buildSlateAutomationWriteRiskTarget(input: AutomationRiskArgs) {
  return new SmartModeRiskTarget({
    action: SLATE_AUTOMATION_WRITE_CLASSIFIER_TARGET_ACTION,
    arguments: Struct.fromJson(automationArgumentsRecord(input) as never),
  });
}


/** What the review is fingerprinted by: the routine itself and where it is referenced. */
function automationWriteFingerprint(target: AutomationWriteTarget) {
  return fingerprintSlateAutoReviewTarget({
    operation: target.operation,
    id: target.id,
    spec: target.spec,
    referencedWorkflows: target.referencedWorkflows ?? [],
    referencingRoutines: target.referencingRoutines ?? [],
  });
}

/** The one-line description of the change shown with the approval card. */
function automationWriteSummary(target: AutomationWriteTarget) {
  return summarizeSlateAutomationWriteAction({
    operation: target.operation,
    name: target.spec.name,
    triggerDescription: describeTrigger(target.spec.trigger),
    prompt: target.spec.prompt,
    isEnabled: target.spec.isEnabled,
    ...(target.referencingRoutines == null
      ? {}
      : { referencingRoutineNames: target.referencingRoutines.map((routine) => routine.name) }),
  });
}

export interface AutomationReviewOptions<Context> {
  readonly mode: SlateAutoReviewMode;
  readonly agentId: string;
  readonly autoReviewController?: Pick<SlateAutoReviewController, "requestApproval">;
  readonly personalInstructions?: InstructionPermissions;
  readonly userAutoRunInstructions?: InstructionPermissions;
  readonly projectAutoRunInstructions?: InstructionPermissions;
  readonly getApprovalExpiryPolicy?: () => SlateAutoReviewExpiryPolicy;
  classify(
    context: Context,
    target: AutomationWriteTarget,
    mode: "shadow" | "enforce",
    toolCallId: string,
  ): Promise<AutoReviewClassifierDecision>;
  reportShadowFailure?(failure: unknown): void;
  suspendToolExecutionTimeout?<T>(context: Context, operation: () => Promise<T>): Promise<T>;
}

export async function reviewSlateAutomationWrite<Context>(input: {
  readonly ctx: Context;
  readonly target: AutomationWriteTarget;
  readonly options: AutomationReviewOptions<Context>;
  readonly toolCallId: string;
  readonly signal?: AbortSignal;
}): Promise<{ readonly allowed: boolean; readonly reason?: string }> {
  const { ctx, target, options: reviewOptions, toolCallId } = input;
  if (reviewOptions.mode === "off") return { allowed: true };
  if (reviewOptions.mode === "shadow") {
    void reviewOptions.classify(ctx, target, "shadow", toolCallId)
      .catch((failure: unknown) => reviewOptions.reportShadowFailure?.(failure));
    return { allowed: true };
  }
  const classifierDecision = await reviewOptions.classify(ctx, target, "enforce", toolCallId);
  if (classifierDecision.kind === "allow") return { allowed: true };
  const approvalController = reviewOptions.autoReviewController;
  if (classifierDecision.kind !== "block" || approvalController == null) {
    return { allowed: false, reason: classifierDecision.reason };
  }
  const approvalRequest = () => approvalController.requestApproval({
    agentId: reviewOptions.agentId,
    surface: "automation_write",
    fingerprint: automationWriteFingerprint(target),
    reason: classifierDecision.reason,
    summary: automationWriteSummary(target),
    ...(classifierDecision.proposedRule == null ? {} : { proposedRule: classifierDecision.proposedRule }),
    ...(input.signal == null ? {} : { signal: input.signal }),
    ...(reviewOptions.getApprovalExpiryPolicy == null
      ? {}
      : { expiryPolicy: reviewOptions.getApprovalExpiryPolicy() }),
  });
  const approvalOutcome = reviewOptions.suspendToolExecutionTimeout == null
    ? await approvalRequest()
    : await reviewOptions.suspendToolExecutionTimeout(ctx, approvalRequest);
  return approvalOutcome.approved
    ? { allowed: true }
    : { allowed: false, reason: approvalOutcome.reason ?? classifierDecision.reason };
}
