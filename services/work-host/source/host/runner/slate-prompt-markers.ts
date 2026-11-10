/** Build a persisted prompt marker from its Slate-owned word parts. */
const markerFor = (parts: readonly string[]): string => `[${parts.join("_")}]`;
const MARKER_PREFIX = ["SLATE"] as const;

export const SLATE_HIDDEN_PROMPT_MARKER = markerFor([...MARKER_PREFIX, "HIDDEN", "PROMPT"]);
export const SLATE_TRUSTED_AUTOMATION_PROMPT_MARKER = markerFor([
  ...MARKER_PREFIX,
  "TRUSTED",
  "AUTOMATION",
  "PROMPT",
]);
