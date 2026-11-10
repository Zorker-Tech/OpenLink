import {
  SummarizationHandler,
  type SummarizationPromptSession,
} from "../../packages/agent-summarization/summarization-handler.ts";

import { isSlateSummaryModelId } from "../../adapters/interop/slate-backend/model-id-aliases-adapter.ts";

export const SLATE_SUMMARIZATION_MAX_PROMPT_CHARS = 2_800_000;

export function shouldUseSlateSelfSummary(modelId: string): boolean {
  return isSlateSummaryModelId(modelId);
}

export function createSlateSummarizationHandler(
  promptSession: SummarizationPromptSession,
  options?: { preserveLatestImage?: boolean },
): SummarizationHandler {
  return new SummarizationHandler(promptSession, false, {
    enableReduceInputsRetry: true,
    maxPromptChars: SLATE_SUMMARIZATION_MAX_PROMPT_CHARS,
    maxOutputTokens: 32_000,
    preserveLatestImage: options?.preserveLatestImage ?? false,
  });
}
