/**
 * The usage panel's copy.
 *
 * Two tiers of models are shown side by side — the ones the plan includes, and the ones metered
 * separately — and the panel has to say the same thing in a tooltip, a bar label and a footnote.
 * The wording lives here so those three stay one voice.
 */

export const USAGE_PANEL_COPY = {
  includedTitle: "Included models",
  includedDescription: "Covered by the usage your plan includes.",
  otherTitle: "Other models",
  otherDescription: "Consumed by named models.",
  beyondLimitDescription: "Additional usage beyond your limits consumes other-model quota or on-demand spend.",
  includedUsageBarLabel: "your included total usage",
  otherUsageBarLabel: "your included API usage",
} as const
