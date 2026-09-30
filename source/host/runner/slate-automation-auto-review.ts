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

export function buildSlateAutomationWriteRiskTarget(args: {
  readonly target: AutomationWriteTarget;
  readonly personalInstructions?: InstructionPermissions;
  readonly userAutoRunInstructions?: InstructionPermissions;
  readonly projectAutoRunInstructions?: InstructionPermissions;
}) {
  const { operation, id, spec, referencedWorkflows, referencingRoutines } = args.target;
  const argumentsJson = JSON.parse(JSON.stringify({
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
      project_permissions: buildProjectPermissionsContext(args),
    }));
  return new SmartModeRiskTarget({
    action: SLATE_AUTOMATION_WRITE_CLASSIFIER_TARGET_ACTION,
    arguments: Struct.fromJson(argumentsJson),
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
  reportShadowFailure?(error: unknown): void;
  suspendToolExecutionTimeout?<T>(context: Context, operation: () => Promise<T>): Promise<T>;
}

export async function reviewSlateAutomationWrite<Context>(args: {
  readonly ctx: Context;
  readonly target: AutomationWriteTarget;
  readonly options: AutomationReviewOptions<Context>;
  readonly toolCallId: string;
  readonly signal?: AbortSignal;
}): Promise<{ readonly allowed: boolean; readonly reason?: string }> {
  const { ctx, target, options, toolCallId } = args;
  if (options.mode === "off") return { allowed: true };
  if (options.mode === "shadow") {
    void options.classify(ctx, target, "shadow", toolCallId)
      .catch((error: unknown) => options.reportShadowFailure?.(error));
    return { allowed: true };
  }
  const decision = await options.classify(ctx, target, "enforce", toolCallId);
  if (decision.kind === "allow") return { allowed: true };
  const controller = options.autoReviewController;
  if (decision.kind !== "block" || controller == null) {
    return { allowed: false, reason: decision.reason };
  }
  const request = () => controller.requestApproval({
    agentId: options.agentId,
    surface: "automation_write",
    fingerprint: fingerprintSlateAutoReviewTarget({
      operation: target.operation,
      id: target.id,
      spec: target.spec,
      referencedWorkflows: target.referencedWorkflows ?? [],
      referencingRoutines: target.referencingRoutines ?? [],
    }),
    reason: decision.reason,
    summary: summarizeSlateAutomationWriteAction({
      operation: target.operation,
      name: target.spec.name,
      triggerDescription: describeTrigger(target.spec.trigger),
      prompt: target.spec.prompt,
      isEnabled: target.spec.isEnabled,
      ...(target.referencingRoutines == null
        ? {}
        : { referencingRoutineNames: target.referencingRoutines.map((routine) => routine.name) }),
    }),
    ...(decision.proposedRule == null ? {} : { proposedRule: decision.proposedRule }),
    ...(args.signal == null ? {} : { signal: args.signal }),
    ...(options.getApprovalExpiryPolicy == null
      ? {}
      : { expiryPolicy: options.getApprovalExpiryPolicy() }),
  });
  const approval = options.suspendToolExecutionTimeout == null
    ? await request()
    : await options.suspendToolExecutionTimeout(ctx, request);
  return approval.approved
    ? { allowed: true }
    : { allowed: false, reason: approval.reason ?? decision.reason };
}
