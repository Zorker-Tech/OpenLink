/**
 * What a user has told the auto-review classifier to always allow or always block.
 *
 * The lists are bounded in both directions — how many instructions there are and how long each may be — and what is
 * stored is trimmed, de-duplicated and in the order the user wrote it, since the order is what a reader of the list
 * sees. A configuration that says nothing is enabled with empty lists rather than disabled, so an untouched setting
 * does not silently turn the classifier off.
 */
export const SLATE_AUTO_REVIEW_INSTRUCTION_MAX_ENTRIES = 20;
export const SLATE_AUTO_REVIEW_INSTRUCTION_MAX_CHARS = 1_000;
export interface SlateAutoReviewInstructions { readonly isEnabled: boolean; readonly allowInstructions: readonly string[]; readonly blockInstructions: readonly string[]; }
export const DEFAULT_SLATE_AUTO_REVIEW_INSTRUCTIONS: SlateAutoReviewInstructions = { isEnabled: true, allowInstructions: [], blockInstructions: [] };
function normalizeInstructionList(raw: unknown): string[] {
  if (!Array.isArray(raw)) return [];
  const result: string[] = []; const seen = new Set<string>();
  for (const item of raw) {
    if (typeof item !== "string") continue;
    const trimmed = item.trim(); const clamped = trimmed.length <= SLATE_AUTO_REVIEW_INSTRUCTION_MAX_CHARS ? trimmed : trimmed.slice(0, SLATE_AUTO_REVIEW_INSTRUCTION_MAX_CHARS);
    if (clamped.length === 0 || seen.has(clamped)) continue;
    seen.add(clamped); result.push(clamped);
    if (result.length >= SLATE_AUTO_REVIEW_INSTRUCTION_MAX_ENTRIES) break;
  }
  return result;
}
export function normalizeSlateAutoReviewInstructions(partial: { readonly isEnabled?: unknown; readonly allowInstructions?: unknown; readonly blockInstructions?: unknown } | null | undefined): SlateAutoReviewInstructions {
  return { isEnabled: partial?.isEnabled !== false, allowInstructions: normalizeInstructionList(partial?.allowInstructions), blockInstructions: normalizeInstructionList(partial?.blockInstructions) };
}
