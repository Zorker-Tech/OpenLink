import type { CompletedAwaitOutcome, Usage } from "./conversation-state-contracts.ts";

export function toSafeTokenCount(value: unknown): number {
  return typeof value === "number" && Number.isFinite(value) && value > 0 ? Math.floor(value) : 0;
}

export function awaitBlockUntilMs(awaitCall: { args?: { blockUntilMs?: unknown } }): number {
  const blockUntilMs = awaitCall.args?.blockUntilMs;
  return blockUntilMs == null ? 0 : Number(blockUntilMs);
}

export function classifyCompletedAwaitOutcome(awaitCall: any): CompletedAwaitOutcome {
  const awaitResult = awaitCall.result?.result?.case === "success"
    ? awaitCall.result.result.value.awaitResult
    : undefined;
  if (awaitResult?.case === "complete") {
    return awaitResult.value.taskId.trim().length === 0 ? "slept_full" : "completed_early";
  }
  if (awaitResult?.case === "stillRunning") {
    return awaitResult.value.regexMatch?.length > 0 ? "completed_early" : "slept_full";
  }
  return "completed_early";
}

export function sanitizeUsage<T extends Record<string, unknown>>(usage: T): T & Usage {
  const promptTokens = toSafeTokenCount(usage.promptTokens);
  const completionTokens = toSafeTokenCount(usage.completionTokens);
  const totalTokens = toSafeTokenCount(usage.totalTokens) || promptTokens + completionTokens;
  return { ...usage, promptTokens, completionTokens, totalTokens };
}

const reportedWindowByModel = new Map<string, number>();

export function lastReportedContextWindow(modelId: string): number | undefined {
  return reportedWindowByModel.get(modelId);
}

export function sanitizeExtendedUsage(usage: Record<string, unknown>, modelId: string) {
  const maxTokens = toSafeTokenCount(usage.maxTokens);
  if (maxTokens > 0) reportedWindowByModel.set(modelId, maxTokens);
  return {
    inputTokens: toSafeTokenCount(usage.inputTokens),
    outputTokens: toSafeTokenCount(usage.outputTokens),
    cacheReadTokens: toSafeTokenCount(usage.cacheReadTokens),
    cacheWriteTokens: toSafeTokenCount(usage.cacheWriteTokens),
    maxTokens,
  };
}
