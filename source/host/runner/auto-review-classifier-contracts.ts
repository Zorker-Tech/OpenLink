export type AutoReviewClassifierDecision =
  | { readonly kind: "allow" }
  | { readonly kind: "block"; readonly reason: string; readonly proposedRule?: string }
  | { readonly kind: "reject"; readonly reason: string }

export interface SlateAutoReviewRiskTarget {
  readonly action: string
  readonly arguments: Readonly<Record<string, unknown>>
}

export function createSlateAutoReviewRiskTarget(
  action: string,
  argumentsValue: Readonly<Record<string, unknown>>,
): SlateAutoReviewRiskTarget {
  return { action, arguments: argumentsValue }
}

export const SLATE_AUTO_REVIEW_BLOCK_REASON = "Blocked by Auto-review"
export const SLATE_AUTO_REVIEW_CLASSIFIER_MAX_ATTEMPTS = 1

export type AutoReviewClassifierResult =
  | { readonly kind: "allow" }
  | { readonly kind: "block"; readonly blockReason?: string; readonly proposedAllowRule?: string }
  | { readonly kind: "unavailable" }
  | { readonly kind: "unknown" }

export function decideAutoReviewClassifierResult(
  result: AutoReviewClassifierResult,
  errorReason: string,
  fallbackBlockReason: string,
): AutoReviewClassifierDecision {
  if (result.kind === "allow") return { kind: "allow" }
  if (result.kind !== "block") return { kind: "reject", reason: errorReason }

  const proposedRule = result.proposedAllowRule?.trim()
  return {
    kind: "block",
    reason: result.blockReason?.trim() || fallbackBlockReason,
    ...(proposedRule !== undefined && proposedRule.length > 0 ? { proposedRule } : {}),
  }
}
