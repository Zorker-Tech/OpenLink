import type { SlateAutoReviewInstructions } from "../../../shared/slate-auto-review-instructions.ts";
import type { SlateAutoReviewMode } from "../../runner/slate-auto-review.ts";
import type { ReviewAwaitingSink } from "./auto-review-awaiting-contracts.ts";

export function parseLocalAutoReviewMode(value: unknown): SlateAutoReviewMode | undefined {
  if (value === "off" || value === "shadow" || value === "enforce") return value;
  return undefined;
}

export const SETTLED_APPROVAL_MEMORY = 256;

export interface AutoReviewUpdateSink {
  (update: unknown): void;
}

export interface AutoReviewServiceDeps<Classifier = unknown, Auth = unknown> {
  readonly auth: Auth;
  readonly experiments: { checkFeatureGate(name: string): boolean };
  readonly settings: { getAutoReviewInstructions(): SlateAutoReviewInstructions };
  readonly telemetry: {
    reportAutoReviewDisplayRecheckFailed(report: { conversationId: string }): void;
    reportAutoReviewApproval(report: Record<string, unknown>): void;
  };
  readonly awaitingSink: ReviewAwaitingSink;
  readonly transcript: {
    settleStaleAutoReviewCard(args: { agentId: string; entryId: string; requestId: string }): Promise<boolean>;
  };
  readonly hostGeneration: string;
  readonly localMode?: SlateAutoReviewMode;
  readonly createClassifierExecutor: (auth: Auth) => Classifier;
  readonly now?: () => number;
}
