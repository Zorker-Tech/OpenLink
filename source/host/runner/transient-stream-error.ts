/**
 * Whether a stream error is worth trying again.
 *
 * A connection that was reset, timed out or refused is transient, and so is a message that names one of those, while
 * anything the platform cannot recognize is treated as a real failure rather than retried forever.
 */

/** The errno codes that mean the connection went away by itself rather than because of what was asked. */
export const TRANSIENT_ERRNO_CODES = new Set(["ECONNRESET", "ETIMEDOUT", "EPIPE", "ECONNABORTED", "ECONNREFUSED", "ENETRESET", "ENETDOWN", "ENETUNREACH", "EHOSTUNREACH", "EAI_AGAIN"]);

/** The fragments a message carries when the connection is what failed, in lower case. */
export const TRANSIENT_MESSAGE_TOKENS = ["econnreset", "etimedout", "epipe", "econnaborted", "econnrefused", "enetreset", "enetunreach", "ehostunreach", "socket hang up", "premature close", "stream closed", "closed stream", "connection reset", "connection closed", "connection terminated", "network error", "the operation was aborted", "[aborted]", "[unavailable]", "[deadline_exceeded]"];

/** What this reader is willing to look at on a thrown value: everything a caller or a transport may have hung on it. */
interface ThrownShape {
  readonly code?: unknown;
  readonly message?: unknown;
  readonly cause?: unknown;
  readonly errors?: unknown;
  readonly name?: unknown;
  readonly reason?: unknown;
  readonly isStepRetriesExhausted?: unknown;
  readonly isConversationTooLarge?: unknown;
  readonly isTranscriptAppendAfterCheckpointError?: unknown;
  readonly retryable?: unknown;
  readonly terminal?: unknown;
  readonly displayInfo?: unknown;
  readonly metadata?: unknown;
}

function shapeOf(value: unknown): ThrownShape | null {
  return typeof value === "object" && value != null ? value : null;
}

/** What a thrown value hangs under it: its cause, and the errors an aggregate error carries. */
function nested(shape: ThrownShape): unknown[] {
  return [shape.cause, ...(Array.isArray(shape.errors) ? shape.errors : [])].filter((value) => value != null);
}

/**
 * Whether a value, or anything it wraps, satisfies the test — each value once, so a cycle of causes ends.
 */
function anywhere(error: unknown, test: (shape: ThrownShape) => boolean, seen = new Set<unknown>()): boolean {
  const shape = shapeOf(error);
  if (shape == null || seen.has(shape)) return false;
  seen.add(shape);
  return test(shape) || nested(shape).some((child) => anywhere(child, test, seen));
}

/** The errno a value names, if it names one this build considers transient. */
function byCode(shape: ThrownShape): boolean {
  return typeof shape.code === "string" && TRANSIENT_ERRNO_CODES.has(shape.code.toUpperCase());
}

/** The message a value carries, if it reads like the connection is what failed. */
function byMessage(shape: ThrownShape): boolean {
  return typeof shape.message === "string" && messageLooksTransient(shape.message);
}

/** Whether a message reads like the connection failed rather than like the request was wrong. */
export function messageLooksTransient(message: string): boolean {
  const lower = message.toLowerCase();
  return TRANSIENT_MESSAGE_TOKENS.some((token) => lower.includes(token));
}

export function isTransientStreamError(error: unknown): boolean {
  if (typeof error === "string") return messageLooksTransient(error);
  return anywhere(error, (shape) => byCode(shape) || byMessage(shape));
}

export function isConversationTooLargeRefusal(error: unknown): boolean {
  return anywhere(error, (shape) => shape.isConversationTooLarge === true);
}

/** A conversation that ran out of context and cannot be summarized any further: retrying cannot help it. */
export function isContextOverflowDeadEnd(error: unknown): boolean {
  return anywhere(
    error,
    (shape) =>
      shape.name === "InputTokenLimitError" ||
      ((shape.isStepRetriesExhausted === true || shape.name === "StepRetriesExhaustedError") && shape.reason === "summarization-retries"),
  );
}

/** Errors that say, on the value itself, that trying again is pointless. */
function refusesRetry(shape: ThrownShape): boolean {
  return shape.terminal === true || shape.name === "NonRetriableError" || shape.name === "ActionRequiredError";
}

export function isRetryableProviderError(error: unknown): boolean {
  if (isContextOverflowDeadEnd(error) || isConversationTooLargeRefusal(error)) return false;
  const retryable = isTransientStreamError(error) || anywhere(error, (shape) => shape.retryable === true);
  if (!retryable) return false;
  return !anywhere(error, refusesRetry);
}

/** The provider's own word for "out of capacity", as its transport puts it on the value. */
const CAPACITY_CONNECT_CODES: ReadonlySet<unknown> = new Set(["Unavailable", 14]);
const EXHAUSTED_CONNECT_CODES: ReadonlySet<unknown> = new Set(["ResourceExhausted", 8]);
const EXHAUSTED_ERROR_CODES: ReadonlySet<unknown> = new Set(["RESOURCE_EXHAUSTED", 8]);

export function isProviderCapacityError(error: unknown): boolean {
  if (!isRetryableProviderError(error)) return false;
  return anywhere(error, (shape) => {
    if (typeof shape.displayInfo !== "object" || shape.displayInfo == null) return false;
    const info = shape.displayInfo as Record<string, unknown>;
    if (CAPACITY_CONNECT_CODES.has(info.connectCode)) return true;
    return EXHAUSTED_CONNECT_CODES.has(info.connectCode) && EXHAUSTED_ERROR_CODES.has(info.errorCode);
  });
}

export class FirstTokenStallError extends Error {
  readonly isFirstTokenStall = true;

  constructor(deadlineMs: number) {
    super(`The model provider did not start responding within ${Math.round(deadlineMs / 1_000)}s.`);
    this.name = "FirstTokenStallError";
  }
}

export function isFirstTokenStallError(error: unknown): boolean {
  if (error instanceof FirstTokenStallError) return true;
  const shape = shapeOf(error);
  if (shape == null) return false;
  return shape.name === "FirstTokenStallError" || (shape as { isFirstTokenStall?: unknown }).isFirstTokenStall === true;
}

/** Whether a turn that just failed is worth running again from where it stopped. */
export function shouldRetryTurnAttempt(turn: {
  canceled: boolean;
  error: unknown;
  streamOutputProduced: boolean;
  resumeCheckpointAvailable: boolean;
  automationIsRetryable?: (error: unknown) => boolean;
}): boolean {
  if (turn.canceled || shapeOf(turn.error)?.isTranscriptAppendAfterCheckpointError === true) return false;
  // Output that cannot be resumed would be written twice, so only a turn with nothing to lose is retried.
  const nothingToLose = !turn.streamOutputProduced || turn.resumeCheckpointAvailable;
  if (nothingToLose && (isRetryableProviderError(turn.error) || isFirstTokenStallError(turn.error))) return true;
  return turn.automationIsRetryable?.(turn.error) ?? false;
}

/** How long to wait before attempt `attempt` again, jittered over its second half. */
export function computeBackoffDelayMs(params: { attempt: number; baseDelayMs: number; maxDelayMs: number; random?: () => number }): number {
  const random = params.random ?? Math.random;
  const base = Math.max(0, params.baseDelayMs);
  const cap = Math.max(base, params.maxDelayMs);
  const exponential = Math.min(cap, base * 2 ** Math.max(0, params.attempt - 1));
  return Math.min(cap, Math.round(exponential / 2 + (random() * exponential) / 2));
}

export const MAX_SERVER_RETRY_AFTER_MS = 30_000;

/** How long the server asked to be left alone, jittered by up to half of it and never beyond the cap. */
export function computeServerPacedDelayMs(params: { retryAfterMs: number; random?: () => number }): number {
  const random = params.random ?? Math.random;
  return Math.min(Math.round(params.retryAfterMs + (random() * params.retryAfterMs) / 2), MAX_SERVER_RETRY_AFTER_MS);
}

/** The wait the server asked for, if any value in the chain carries one — in seconds, reported in milliseconds. */
export function serverRetryAfterMsFromError(error: unknown): number | undefined {
  let found: number | undefined;
  anywhere(error, (shape) => {
    const metadata = shape.metadata;
    let raw: unknown;
    if (metadata instanceof Map) raw = metadata.get("retry-after");
    else if (typeof metadata === "object" && metadata != null && "get" in metadata && typeof metadata.get === "function") {
      raw = (metadata.get as (key: string) => unknown)("retry-after");
    }
    if (raw == null || raw === "") return false;
    const seconds = Number(raw);
    if (Number.isFinite(seconds) && seconds >= 0) found = Math.min(Math.round(seconds * 1_000), MAX_SERVER_RETRY_AFTER_MS);
    return found != null;
  });
  return found;
}

export interface RetryPolicy {
  readonly maxAttempts: number;
  readonly baseDelayMs: number;
  readonly maxDelayMs: number;
  readonly isRetryable?: (error: unknown) => boolean;
  readonly sleep?: (delayMs: number) => Promise<void>;
  readonly random?: () => number;
  readonly onRetry?: (info: { attempt: number; delayMs: number; serverPaced: boolean; error: unknown }) => void;
}

/** Runs something that may fail transiently, waiting between attempts, and hands back the first result that works. */
export async function runWithTransientRetry<T>(run: () => Promise<T>, policy: RetryPolicy): Promise<T> {
  const attempts = Math.max(1, Math.floor(policy.maxAttempts));
  const isRetryable = policy.isRetryable ?? isTransientStreamError;
  const sleep = policy.sleep ?? ((delayMs: number) => new Promise<void>((resolve) => setTimeout(resolve, delayMs)));
  for (let attempt = 1; ; attempt += 1) {
    try {
      return await run();
    } catch (error) {
      if (attempt >= attempts || !isRetryable(error)) throw error;
      const server = serverRetryAfterMsFromError(error);
      const delayMs =
        server == null
          ? computeBackoffDelayMs({ attempt, baseDelayMs: policy.baseDelayMs, maxDelayMs: policy.maxDelayMs, ...(policy.random == null ? {} : { random: policy.random }) })
          : computeServerPacedDelayMs({ retryAfterMs: server, ...(policy.random == null ? {} : { random: policy.random }) });
      policy.onRetry?.({ attempt, delayMs, serverPaced: server != null, error });
      await sleep(delayMs);
    }
  }
}

export const DEFAULT_AUTOMATION_STREAM_RETRY_MAX_ATTEMPTS = 4;
export const DEFAULT_AUTOMATION_STREAM_RETRY_BASE_DELAY_MS = 1_000;
export const DEFAULT_AUTOMATION_STREAM_RETRY_MAX_DELAY_MS = 15_000;
export const DEFAULT_OVERLOAD_STREAM_RETRY_MAX_ATTEMPTS = 3;
export const DEFAULT_OVERLOAD_STREAM_RETRY_BASE_DELAY_MS = 750;
export const DEFAULT_OVERLOAD_STREAM_RETRY_MAX_DELAY_MS = 6_000;
export const DEFAULT_FIRST_TOKEN_STALL_DEADLINE_MS = 150_000;

/** An integer from the environment, or the fallback when it is missing, unreadable or below its floor. */
function readIntEnv(environment: NodeJS.ProcessEnv, name: string, fallback: number, floor: number): number {
  const parsed = Number.parseInt(environment[name]?.trim() ?? "", 10);
  return Number.isFinite(parsed) && parsed >= floor ? parsed : fallback;
}

export function resolveAutomationStreamRetryPolicy(overrides: Partial<RetryPolicy> = {}, environment: NodeJS.ProcessEnv = process.env): RetryPolicy {
  return {
    maxAttempts: readIntEnv(environment, "SLATE_AUTOMATION_STREAM_RETRY_ATTEMPTS", 4, 1),
    baseDelayMs: readIntEnv(environment, "SLATE_AUTOMATION_STREAM_RETRY_BASE_MS", 1_000, 0),
    maxDelayMs: readIntEnv(environment, "SLATE_AUTOMATION_STREAM_RETRY_MAX_MS", 15_000, 0),
    ...overrides,
  };
}

export function resolveOverloadStreamRetryPolicy(overrides: Partial<RetryPolicy> = {}, environment: NodeJS.ProcessEnv = process.env): RetryPolicy {
  return {
    maxAttempts: readIntEnv(environment, "SLATE_OVERLOAD_STREAM_RETRY_ATTEMPTS", 3, 1),
    baseDelayMs: readIntEnv(environment, "SLATE_OVERLOAD_STREAM_RETRY_BASE_MS", 750, 0),
    maxDelayMs: readIntEnv(environment, "SLATE_OVERLOAD_STREAM_RETRY_MAX_MS", 6_000, 0),
    ...overrides,
  };
}

export function resolveFirstTokenStallDeadlineMs(environment: NodeJS.ProcessEnv = process.env): number {
  return readIntEnv(environment, "SLATE_FIRST_TOKEN_STALL_DEADLINE_MS", DEFAULT_FIRST_TOKEN_STALL_DEADLINE_MS, 0);
}
