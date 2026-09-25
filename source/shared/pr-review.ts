/** Where a pull request's review is asked for, and the preferences that say so. */
export type SlatePrReviewDestination = "github" | "graphite" | "reviewSlate";

export interface SlatePrReviewPreferences {
  readonly user: SlatePrReviewDestination | undefined;
  readonly team: SlatePrReviewDestination | undefined;
}

export const NO_SLATE_PR_REVIEW_PREFERENCES: SlatePrReviewPreferences = {
  user: undefined,
  team: undefined,
};
