import { TELEMETRY_DROP_REASONS } from "./telemetry-events.ts";
import { ClientLogLevel, type DropCounters, type StructuredLogLevel } from "./structured-log-transport-contracts.ts";
export { STRUCTURED_LOG_REPLAY_MAX_AGE_MS } from "../../packages/constants/structured-log.ts";

export const MAX_BUFFER_SIZE = 1_000;
export const STRUCTURED_LOG_SUBMIT_DEADLINE_MS = 15_000;
export const DEADLINE_EXPIRY_CODE = "deadline_exceeded";

export function isDeadlineExpiry(error: unknown): boolean {
  return typeof error === "object"
    && error !== null
    && "code" in error
    && error.code === DEADLINE_EXPIRY_CODE;
}

export function createDropCounterId(): string {
  const bytes = new Uint8Array(16);
  globalThis.crypto.getRandomValues(bytes);
  return [...bytes].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}

export function emptyDropCounters(): DropCounters {
  return Object.fromEntries(
    TELEMETRY_DROP_REASONS.map((reason) => [reason, { observed: 0, acknowledgedThrough: 0 }]),
  ) as DropCounters;
}

export function cloneDropCounters(counters: DropCounters): DropCounters {
  return Object.fromEntries(
    TELEMETRY_DROP_REASONS.map((reason) => [reason, { ...counters[reason] }]),
  ) as DropCounters;
}

export function isValidLogShipReceipt(
  response: { readonly logsProcessed: unknown; readonly logsDropped: unknown },
  requestSize: number,
): response is { readonly logsProcessed: number; readonly logsDropped: number } {
  const { logsProcessed, logsDropped } = response;
  return Number.isSafeInteger(logsProcessed)
    && (logsProcessed as number) >= 0
    && Number.isSafeInteger(logsDropped)
    && (logsDropped as number) >= 0
    && (logsProcessed as number) + (logsDropped as number) === requestSize;
}

export function cleanStructuredLogMetadata(
  metadata: Readonly<Record<string, string | undefined>>,
): Record<string, string> {
  return Object.fromEntries(
    Object.entries(metadata).filter((entry): entry is [string, string] => {
      const value = entry[1];
      return value !== undefined && value.length > 0;
    }),
  );
}

export function truncateStructuredLogValue(value: string, max: number): string {
  return value.length > max ? value.slice(0, max) : value;
}

export function toClientLogLevel(level: StructuredLogLevel): ClientLogLevel {
  switch (level) {
    case "debug":
      return ClientLogLevel.DEBUG;
    case "info":
      return ClientLogLevel.INFO;
    case "warn":
      return ClientLogLevel.WARN;
    case "error":
      return ClientLogLevel.ERROR;
  }
}
