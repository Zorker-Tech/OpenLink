import { SLATE_HIDDEN_PROMPT_MARKER } from "./slate-prompt-markers.ts";
import type { RecentUserMessage } from "./conversation-state-contracts.ts";

export function selectUnconfirmedUserMessages<T extends RecentUserMessage>(params: {
  readonly recentUserMessages: readonly T[];
  readonly currentMessageId?: string;
  readonly lastTurnUserMessageId?: string;
  readonly hasConfirmedTurns: boolean;
}): T[] {
  const { recentUserMessages, currentMessageId, lastTurnUserMessageId, hasConfirmedTurns } = params;
  if (!currentMessageId) return [];
  const currentIndex = recentUserMessages.findIndex(({ id }) => id === currentMessageId);
  if (currentIndex < 0) return [];

  let firstUnconfirmedIndex: number;
  if (lastTurnUserMessageId) {
    const lastConfirmedIndex = recentUserMessages.findIndex(({ id }) => id === lastTurnUserMessageId);
    if (lastConfirmedIndex < 0) return [];
    firstUnconfirmedIndex = lastConfirmedIndex + 1;
  } else if (!hasConfirmedTurns) {
    firstUnconfirmedIndex = 0;
  } else {
    return [];
  }
  if (firstUnconfirmedIndex >= currentIndex) return [];
  return recentUserMessages.slice(firstUnconfirmedIndex, currentIndex).filter(({ text }) => text.trim().length > 0);
}

function usablePromptTexts(values: readonly string[]): string[] {
  return values.map((value) => value.trim()).filter((value) => value.length > 0);
}

function skippedPromptNote(prompts: readonly string[]): string | undefined {
  if (prompts.length === 0) return undefined;
  if (prompts.length === 1) {
    return `Earlier you prompted the user and they moved on without responding ("${prompts[0]}") — treat it as skipped. Don't wait for or assume a response; continue with what you already know, and only ask again if you still genuinely need it.`;
  }
  const list = prompts.map((prompt) => `\n- "${prompt}"`).join("");
  return `Earlier you prompted the user for these and they moved on without responding — treat them as skipped:${list}\nDon't wait for or assume responses; continue with what you already know, and only ask again if you still genuinely need to.`;
}

function dismissedPromptNote(prompts: readonly string[]): string | undefined {
  if (prompts.length === 0) return undefined;
  if (prompts.length === 1) {
    return `The user dismissed your question ("${prompts[0]}") without answering — they'd rather not respond. Don't ask it again or wait for an answer; continue with what you already know and decide yourself.`;
  }
  const list = prompts.map((prompt) => `\n- "${prompt}"`).join("");
  return `The user dismissed these questions without answering — they'd rather not respond:${list}\nDon't ask them again or wait for answers; continue with what you already know and decide yourself.`;
}

export function buildUnansweredQuestionsNote(prompts: { skipped: readonly string[]; dismissed: readonly string[] }): string {
  const sections = [
    skippedPromptNote(usablePromptTexts(prompts.skipped)),
    dismissedPromptNote(usablePromptTexts(prompts.dismissed)),
  ].filter((section): section is string => section !== undefined);
  return sections.length === 0 ? "" : `${SLATE_HIDDEN_PROMPT_MARKER}${sections.join("\n\n")}`;
}
