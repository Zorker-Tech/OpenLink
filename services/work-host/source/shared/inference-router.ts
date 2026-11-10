export const SLATE_INFERENCE_PROVIDERS = ["slate", "claude-code", "codex", "openrouter"] as const;
export type SlateInferenceProvider = (typeof SLATE_INFERENCE_PROVIDERS)[number];

const KNOWN_INFERENCE_PROVIDERS = new Set<string>(SLATE_INFERENCE_PROVIDERS);

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
  return typeof value === "string" && KNOWN_INFERENCE_PROVIDERS.has(value);
}

function freshProviderUsage(): SlateInferenceRouterUsageProvider {
  return {
    requests: 0,
    inputTokens: 0,
    outputTokens: 0,
    cacheReadTokens: 0,
    cacheWriteTokens: 0,
    lastUsedAt: null,
  };
}

function freshProviderUsageIndex(): Record<SlateInferenceProvider, SlateInferenceRouterUsageProvider> {
  const entries = SLATE_INFERENCE_PROVIDERS.map(provider => [provider, freshProviderUsage()] as const);
  return Object.fromEntries(entries) as Record<SlateInferenceProvider, SlateInferenceRouterUsageProvider>;
}

export function emptySlateInferenceRouterUsage(): SlateInferenceRouterUsage {
  return {
    schemaVersion: 1,
    providers: freshProviderUsageIndex(),
  };
}
