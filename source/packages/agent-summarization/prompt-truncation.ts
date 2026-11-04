import { createHistogram } from "../metrics/index.ts";
import { maxMinCharacterShares } from "./prompt-truncation-allocation.ts";
import type { TruncatePromptFairlyParams, TruncatePromptFairlyResult } from "./prompt-truncation-contracts.ts";
import { truncateWithUserQuery } from "./prompt-truncation-user-query.ts";

export type { TruncatePromptFairlyParams, TruncatePromptFairlyResult } from "./prompt-truncation-contracts.ts";

export const MAX_SUMMARIZATION_PROMPT_CHARS = 3_200_000;
const computeMaxMinFairAllocationsDurationMs = createHistogram(
  "agent.summarization.compute_maxmin_fair_allocations_duration_ms",
  { description: "Wall time to compute max-min fair character allocations during prompt truncation" },
);
const DEFAULT_MIN_USEFUL_CHARS = 200;

export function formatOmittedMessagesPreamble(omittedCount: number): string {
  return `[${omittedCount} message(s) omitted due to size limits; omitted content may appear anywhere in the conversation. See transcript file for full history.]\n\n`;
}

export function truncatePromptFairly(params: TruncatePromptFairlyParams): TruncatePromptFairlyResult | null {
  const { ctx, serialized, roles, suffix, charBudget, minUsefulChars = DEFAULT_MIN_USEFUL_CHARS } = params;
  const separatorSize = 2;
  const separatorOverhead = Math.max(0, serialized.length - 1) * separatorSize;
  const preamble = formatOmittedMessagesPreamble(serialized.length);
  const contentBudget = Math.max(0, charBudget - suffix.length - separatorOverhead - preamble.length);
  const sizes = serialized.map((message) => message.length);
  const startedAt = performance.now();
  const allocations = maxMinCharacterShares(sizes, contentBudget);
  computeMaxMinFairAllocationsDurationMs.histogram(ctx, performance.now() - startedAt);

  const resultParts: string[] = [];
  let droppedCount = 0;
  let truncatedCount = 0;
  let fullCount = 0;
  for (let index = 0; index < serialized.length; index += 1) {
    const message = serialized[index]!;
    const allowedChars = allocations[index]!;
    if (allowedChars >= sizes[index]!) {
      resultParts.push(message);
      fullCount += 1;
      continue;
    }
    if (allowedChars < minUsefulChars) {
      droppedCount += 1;
      resultParts.push(`[omitted ${roles[index]} message, ${message.length} chars]`);
      continue;
    }

    const note = `\n[... truncated, ${message.length} chars]`;
    const contentAllowance = Math.max(0, allowedChars - note.length);
    const excerpt = roles[index] === "user"
      ? truncateWithUserQuery(message, contentAllowance)
      : message.slice(0, contentAllowance);
    resultParts.push(excerpt + note);
    truncatedCount += 1;
  }

  if (fullCount + truncatedCount === 0) return null;
  return { resultParts, droppedCount, truncatedCount, fullCount };
}
