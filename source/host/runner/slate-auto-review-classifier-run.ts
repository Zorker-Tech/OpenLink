/**
 * Running the classifier that decides whether a change needs a review.
 *
 * The classifier runs where the platform runs it rather than in the agent's own process, and what it answers is turned
 * into the verdict the review path acts on; a classifier that cannot run says so instead of guessing.
 */
import type { Context } from "../../packages/context/context.ts";
import { smartModeClassifierExecutorResource } from "../../packages/agent-exec/smart-mode-classifier-operation.ts";
import type { RemoteExecManager } from "../../packages/agent-exec/executor-resources.ts";
import type { ResourceAccessor } from "../../packages/agent-exec/resource-provider.ts";
import { getConversationId } from "../../packages/agent/utils/request-scope.ts";
import { executeSmartModeClassifierWithMeasurement } from "../../packages/agent/utils/smart-mode-classifier-measurement.ts";
import {
  SmartModeClassifierArgs,
  SmartModeClassifierDecision,
  type SmartModeClassifierConversationMessage,
  SmartModeRiskTarget,
} from "../../packages/proto/generated/agent/v1/smart_mode_classifier_exec_pb.ts";

export const SLATE_AUTO_REVIEW_BLOCK_REASON = "Blocked by Auto-review";
export const SLATE_AUTO_REVIEW_CLASSIFIER_MAX_ATTEMPTS = 1;

export type AutoReviewClassifierDecision =
  | { readonly kind: "allow" }
  | { readonly kind: "block"; readonly reason: string; readonly proposedRule?: string }
  | { readonly kind: "reject"; readonly reason: string };

export async function runSlateAutoReviewClassifier(args: {
  readonly ctx: Context;
  readonly resourceAccessor: ResourceAccessor<RemoteExecManager>;
  readonly toolCallId: string;
  readonly mode: "shadow" | "enforce";
  readonly buildTarget: () => SmartModeRiskTarget;
  readonly loadConversationContext: () => Promise<SmartModeClassifierConversationMessage[]>;
  readonly workspacePaths?: readonly string[];
  readonly errorReason: string;
}): Promise<AutoReviewClassifierDecision> {
  try {
    const executor = args.resourceAccessor.get(smartModeClassifierExecutorResource);
    const parentConversationId = getConversationId(args.ctx);
    const result = await executeSmartModeClassifierWithMeasurement(
      args.ctx,
      executor,
      new SmartModeClassifierArgs({
        toolCallId: args.toolCallId,
        parentConversationId: parentConversationId!,
        target: args.buildTarget(),
        conversationContext: await args.loadConversationContext(),
      }),
      args.mode,
      args.workspacePaths,
      {
        suppressToolCallIdLogging: true,
        maxAttempts: SLATE_AUTO_REVIEW_CLASSIFIER_MAX_ATTEMPTS,
      },
    );
    if (result.result.case !== "success") {
      return { kind: "reject", reason: args.errorReason };
    }
    const { decision, blockReason, proposedAllowRule } = result.result.value;
    if (decision === SmartModeClassifierDecision.BLOCK) {
      const proposedRule = proposedAllowRule?.trim();
      return {
        kind: "block",
        reason: blockReason?.trim() || SLATE_AUTO_REVIEW_BLOCK_REASON,
        ...(proposedRule !== undefined && proposedRule.length > 0 ? { proposedRule } : {}),
      };
    }
    return decision === SmartModeClassifierDecision.ALLOW
      ? { kind: "allow" }
      : { kind: "reject", reason: args.errorReason };
  } catch (error: unknown) {
    if (error instanceof Error && error.name === "AbortError") throw error;
    return { kind: "reject", reason: args.errorReason };
  }
}
