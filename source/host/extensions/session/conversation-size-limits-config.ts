import type { ConversationSizeLimits } from "./conversation-size-limits-contracts.ts";

export const SOFT_LIMIT_DEFAULT_BYTES = 256 * 1024 * 1024;
export const HARD_LIMIT_DEFAULT_BYTES = 1024 * 1024 * 1024;
export const GC_PENDING_WRITE_RETENTION_MS = 60_000;
export const SOFT_GC_MIN_INTERVAL_MS = 30 * 60_000;

let sizeLimitSource: (() => ConversationSizeLimits) | null = null;
let gcIsPinnedEnabled = false;

function byteOverrideFromEnvironment(name: string, env: NodeJS.ProcessEnv): number | undefined {
  const text = env[name]?.trim();
  if (!text) return undefined;
  const amount = Number(text);
  return Number.isFinite(amount) && amount > 0 ? Math.floor(amount) : undefined;
}

function bytesFromConfiguredLimit(field: keyof ConversationSizeLimits): number | undefined {
  const megabytes = sizeLimitSource?.()[field];
  if (megabytes == null || !Number.isFinite(megabytes) || megabytes <= 0) return undefined;
  return Math.floor(megabytes * 1024 * 1024);
}

export function pinConversationSizeLimitsReader(reader: (() => ConversationSizeLimits) | null): void {
  sizeLimitSource = reader;
}

export function conversationSoftLimitBytes(env: NodeJS.ProcessEnv = process.env): number {
  return byteOverrideFromEnvironment("SLATE_CONVERSATION_SOFT_LIMIT_BYTES", env)
    ?? bytesFromConfiguredLimit("soft_limit_mb")
    ?? SOFT_LIMIT_DEFAULT_BYTES;
}

export function conversationHardLimitBytes(env: NodeJS.ProcessEnv = process.env): number {
  return byteOverrideFromEnvironment("SLATE_CONVERSATION_HARD_LIMIT_BYTES", env)
    ?? bytesFromConfiguredLimit("hard_limit_mb")
    ?? HARD_LIMIT_DEFAULT_BYTES;
}

export function pinConversationGc(enabled: boolean): void {
  gcIsPinnedEnabled = enabled;
}

export function isConversationGcEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
  const setting = env.SLATE_CONVERSATION_GC?.trim().toLowerCase();
  if (["1", "true", "on"].includes(setting ?? "")) return true;
  if (["0", "false", "off"].includes(setting ?? "")) return false;
  return gcIsPinnedEnabled;
}
