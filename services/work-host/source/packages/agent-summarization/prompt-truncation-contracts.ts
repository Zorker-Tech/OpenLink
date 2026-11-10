import type { Context } from "../context/context.ts";

export interface TruncatePromptFairlyParams {
  readonly ctx: Context;
  readonly serialized: readonly string[];
  readonly roles: readonly string[];
  readonly suffix: string;
  readonly charBudget: number;
  readonly minUsefulChars?: number;
}

export interface TruncatePromptFairlyResult {
  readonly resultParts: string[];
  readonly droppedCount: number;
  readonly truncatedCount: number;
  readonly fullCount: number;
}
