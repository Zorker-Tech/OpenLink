import type { SlateAutoReviewController, SlateAutoReviewMode } from "./slate-auto-review.ts";

export interface AutoReviewModes {
  readonly hostShell: SlateAutoReviewMode;
  readonly boxShell: SlateAutoReviewMode;
  readonly mcp: SlateAutoReviewMode;
  readonly computer: SlateAutoReviewMode;
  readonly automationWrite: SlateAutoReviewMode;
  readonly cloudAgent: SlateAutoReviewMode;
  readonly subagentLaunch: SlateAutoReviewMode;
}

export interface AutoReviewInstructions {
  readonly allowInstructions: readonly string[];
  readonly blockInstructions: readonly string[];
}

export interface AutoReviewGatePorts {
  readonly baseModes: AutoReviewModes;
  readonly getModes?: () => AutoReviewModes;
  readonly controller: () => SlateAutoReviewController | undefined;
  readonly resolveBoxId: () => string;
  readonly getInstructions?: () => AutoReviewInstructions | undefined;
}

export class AutoReviewApprovalWaitError extends Error {
  override readonly name = "AutoReviewApprovalWaitError";
}
