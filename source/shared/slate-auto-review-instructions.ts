/**
 * What a user has told the auto-review classifier to always allow or always block.
 *
 * The lists are bounded in both directions — how many instructions there are and how long each may be — and what is
 * stored is trimmed, de-duplicated and in the order the user wrote it, since the order is what a reader of the list
 * sees. A configuration that says nothing is enabled with empty lists rather than disabled, so an untouched setting
 * does not silently turn the classifier off.
 */

/** How many instructions one list may hold. */
export const SLATE_AUTO_REVIEW_INSTRUCTION_MAX_ENTRIES = 20;

/** How long one instruction may be. */
export const SLATE_AUTO_REVIEW_INSTRUCTION_MAX_CHARS = 1_000;

/** The classifier's instruction lists: whether auto review runs, and what it must always allow or block. */
export interface SlateAutoReviewInstructions {
  readonly isEnabled: boolean;
  readonly allowInstructions: readonly string[];
  readonly blockInstructions: readonly string[];
}

/** What an untouched setting means: on, with nothing allowed or blocked in particular. */
export const DEFAULT_SLATE_AUTO_REVIEW_INSTRUCTIONS: SlateAutoReviewInstructions = {
  isEnabled: true,
  allowInstructions: [],
  blockInstructions: [],
};

/** One instruction as it is stored: trimmed and cut to the length limit, or null when nothing is left of it. */
function cleanInstruction(rawItem: unknown): string | null {
  if (typeof rawItem !== "string") return null;
  const trimmedItem = rawItem.trim();
  if (trimmedItem.length === 0) return null;
  return trimmedItem.slice(0, SLATE_AUTO_REVIEW_INSTRUCTION_MAX_CHARS);
}

/** The list as it is stored: the user's order, without blanks and repeats, up to the entry limit. */
function normalizeInstructionList(rawList: unknown): string[] {
  if (!Array.isArray(rawList)) return [];
  const kept: string[] = [];
  const alreadyKept = new Set<string>();
  for (const entry of rawList) {
    const instruction = cleanInstruction(entry);
    if (instruction === null || alreadyKept.has(instruction)) continue;
    alreadyKept.add(instruction);
    kept.push(instruction);
    if (kept.length >= SLATE_AUTO_REVIEW_INSTRUCTION_MAX_ENTRIES) break;
  }
  return kept;
}

export function normalizeSlateAutoReviewInstructions(
  stored: { readonly isEnabled?: unknown; readonly allowInstructions?: unknown; readonly blockInstructions?: unknown } | null | undefined,
): SlateAutoReviewInstructions {
  return {
    isEnabled: stored?.isEnabled !== false,
    allowInstructions: normalizeInstructionList(stored?.allowInstructions),
    blockInstructions: normalizeInstructionList(stored?.blockInstructions),
  };
}
