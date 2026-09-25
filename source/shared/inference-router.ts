export const SLATE_INFERENCE_PROVIDERS = ["slate", "claude-code", "codex", "openrouter"] as const;
export type SlateInferenceProvider = (typeof SLATE_INFERENCE_PROVIDERS)[number];

export interface SlateInferenceRouterUsageProvider {
  readonly requests: number;
  readonly inputTokens: number;
  readonly outputTokens: number;
  readonly cacheReadTokens: number;
  readonly cacheWriteTokens: number;
  readonly lastUsedAt: string | null;
}

export interface SlateInferenceRouterUsage {
  readonly schemaVersion: 1;
  readonly providers: Record<SlateInferenceProvider, SlateInferenceRouterUsageProvider>;
}

export function isSlateInferenceProvider(value: unknown): value is SlateInferenceProvider {
  return typeof value === "string" && (SLATE_INFERENCE_PROVIDERS as readonly string[]).includes(value);
}

export function emptySlateInferenceRouterUsage(): SlateInferenceRouterUsage {
  const empty = (): SlateInferenceRouterUsageProvider => ({ requests: 0, inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0, lastUsedAt: null });
  return { schemaVersion: 1, providers: { slate: empty(), "claude-code": empty(), codex: empty(), openrouter: empty() } };
}
