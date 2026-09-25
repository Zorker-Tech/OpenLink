/**
 * Fitting a conversation into the room a summary has for it, fairly.
 *
 * A conversation that is too large to summarize has to lose something, and the question is what: dropping
 * the oldest messages loses the beginning of the work, dropping the newest loses what the user just asked
 * for, and truncating every message equally leaves nothing readable. So the budget is shared as fairly as
 * the sizes allow — a message smaller than its share keeps all of itself and the room it did not need goes
 * to the others — and only then is a message cut, at a boundary that keeps the user's own words: the
 * `<user_query>` blocks a message carries are kept whole and the rest of it is what gives way.
 *
 * A message that would be cut below a useful size is dropped entirely and replaced by a note saying how much
 * was lost, because half a sentence is worse than an honest gap. A preamble tells the reader that messages
 * were omitted and where the full history is, and a result that kept nothing at all is reported as nothing
 * rather than as an empty prompt — the caller has to decide what to do about that.
 */

import type { Context } from "../context/context.ts";
import { createHistogram } from "../metrics/index.ts";

export const MAX_SUMMARIZATION_PROMPT_CHARS = 3_200_000;

const computeMaxMinFairAllocationsDurationMs = createHistogram(
  "agent.summarization.compute_maxmin_fair_allocations_duration_ms",
  { description: "Wall time to compute max-min fair character allocations during prompt truncation" },
);

const DEFAULT_MIN_USEFUL_CHARS = 200;

export function formatOmittedMessagesPreamble(omittedCount: number): string {
  return `[${omittedCount} message(s) omitted due to size limits; omitted content may appear anywhere in the conversation. See transcript file for full history.]\n\n`;
}

function computeMaxMinFairAllocations(sizes: readonly number[], totalBudget: number): number[] {
  const n = sizes.length;
  if (n === 0) return [];
  const allocations = new Array<number>(n).fill(0);
  const sortedIndices = Array.from({ length: n }, (_, index) => index);
  sortedIndices.sort((a, b) => sizes[a]! - sizes[b]!);
  let remainingBudget = totalBudget;
  let remainingCount = n;
  for (const index of sortedIndices) {
    const fairShare = Math.floor(remainingBudget / remainingCount);
    const actualSize = sizes[index]!;
    if (actualSize <= fairShare) {
      allocations[index] = actualSize;
      remainingBudget -= actualSize;
    } else {
      allocations[index] = fairShare;
      remainingBudget -= fairShare;
    }
    remainingCount--;
  }
  return allocations;
}

function truncatePreservingUserQuery(entry: string, maxChars: number): string {
  const regex = /<user_query>[\s\S]*?<\/user_query>/g;
  const matches = [...entry.matchAll(regex)];
  if (matches.length === 0) return entry.slice(0, maxChars);
  const queryBlocks = matches.map(match => match[0]).join("\n");
  if (queryBlocks.length >= maxChars) return queryBlocks.slice(0, maxChars);
  const rest = entry.replace(regex, "").replace(/\n{3,}/g, "\n\n").trim();
  if (rest.length === 0) return queryBlocks;
  const separator = "\n";
  const restBudget = maxChars - queryBlocks.length - separator.length;
  if (restBudget <= 0) return queryBlocks;
  return rest.slice(0, restBudget) + separator + queryBlocks;
}

export interface TruncatePromptFairlyParams {
  readonly ctx: Context;
  readonly serialized: readonly string[];
  readonly roles: readonly string[];
  readonly suffix: string;
  readonly charBudget: number;
  readonly minUsefulChars?: number | undefined;
}

export interface TruncatePromptFairlyResult {
  readonly resultParts: string[];
  readonly droppedCount: number;
  readonly truncatedCount: number;
  readonly fullCount: number;
}

export function truncatePromptFairly(params: TruncatePromptFairlyParams): TruncatePromptFairlyResult | null {
  const {
    ctx,
    serialized,
    roles,
    suffix,
    charBudget,
    minUsefulChars = DEFAULT_MIN_USEFUL_CHARS,
  } = params;
  const separator = "\n\n";
  const separatorOverhead = serialized.length > 1 ? (serialized.length - 1) * separator.length : 0;
  const maxPreambleText = formatOmittedMessagesPreamble(serialized.length);
  const contentBudget = Math.max(0, charBudget - suffix.length - separatorOverhead - maxPreambleText.length);
  const sizes = serialized.map(value => value.length);
  const maxMinStartMs = performance.now();
  const allocations = computeMaxMinFairAllocations(sizes, contentBudget);
  computeMaxMinFairAllocationsDurationMs.histogram(ctx, performance.now() - maxMinStartMs);
  const resultParts: string[] = [];
  let droppedCount = 0;
  let truncatedCount = 0;
  let fullCount = 0;
  for (let index = 0; index < serialized.length; index++) {
    const allocation = allocations[index]!;
    const actualSize = sizes[index]!;
    if (allocation >= actualSize) {
      resultParts.push(serialized[index]!);
      fullCount++;
    } else if (allocation < minUsefulChars) {
      droppedCount++;
      resultParts.push(`[omitted ${roles[index]} message, ${actualSize} chars]`);
    } else {
      const entry = serialized[index]!;
      const note = `\n[... truncated, ${entry.length} chars]`;
      const contentAllocation = Math.max(0, allocation - note.length);
      const truncated = roles[index] === "user"
        ? truncatePreservingUserQuery(entry, contentAllocation)
        : entry.slice(0, contentAllocation);
      resultParts.push(truncated + note);
      truncatedCount++;
    }
  }
  if (fullCount + truncatedCount === 0) return null;
  return { resultParts, droppedCount, truncatedCount, fullCount };
}
