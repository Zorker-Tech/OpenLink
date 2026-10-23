/**
 * What a failed summarization means, and whether trying again could help.
 *
 * Summarizing is a model call like any other, so it fails in the ways a model call fails — and the caller
 * has to decide, per failure, whether to try again, to ask for a shorter answer, or to send less input. That
 * decision is what this module is: every failure is read for what it was, including the codes a connect
 * error carries and the cause chain a wrapped error hides it in, and each is answered with a directive
 * rather than a bare retry flag, because "try again" and "try again with less input" are different actions.
 *
 * The defaults are the cautious ones. A failure the platform cannot classify is retried once, since most of
 * them are transient, but the two that mean the request itself was wrong — too much input, too much output —
 * are only retried when the session has asked for that, because retrying them unchanged would fail the same
 * way. A failure that means the user aborted, or that the client's stream is gone, is never retried: there is
 * nobody left to answer.
 */

import { InputTokenLimitError, OutputTokensLimitExceededError } from "../chat-inference/prompt-executor.ts";

export class NoSummaryResponseError extends Error {
  constructor() {
    super("No assistant response received");
    this.name = "NoSummaryResponseError";
    Object.setPrototypeOf(this, NoSummaryResponseError.prototype);
  }
}

const CONNECT_CODES = {
  InvalidArgument: 3,
  NotFound: 5,
  ResourceExhausted: 8,
  Aborted: 10,
  Unavailable: 14,
  Unauthenticated: 16,
};

function* walkErrorChain(error: unknown): Generator<unknown> {
  let cursor = error;
  const visited = new Set<unknown>();
  while (cursor !== undefined && cursor !== null && !visited.has(cursor)) {
    visited.add(cursor);
    yield cursor;
    if (cursor instanceof Error) cursor = cursor.cause;
    else break;
  }
}

function chainHasName(error: unknown, wantedName: string): boolean {
  for (const cursor of walkErrorChain(error)) {
    if (cursor instanceof Error && cursor.name === wantedName) return true;
  }
  return false;
}

function chainMessageHas(error: unknown, wantedText: string): boolean {
  const loweredWantedText = wantedText.toLowerCase();
  for (const cursor of walkErrorChain(error)) {
    if (cursor instanceof Error && cursor.message.toLowerCase().includes(loweredWantedText)) return true;
  }
  return false;
}

function chainHasConnectCode(error: unknown, wantedCode: number): boolean {
  for (const cursor of walkErrorChain(error)) {
    if (typeof cursor === "object" && cursor !== null && "code" in cursor && cursor.code === wantedCode) return true;
  }
  return false;
}

function isOversizedTextFieldsError(error: unknown): boolean {
  return chainMessageHas(error, "request contains text fields that are too large");
}

function isInvalidJsonFailure(error: unknown): boolean {
  return chainMessageHas(error, "not valid json") || chainMessageHas(error, "invalid json");
}

function isInvalidArgumentFailure(error: unknown): boolean {
  return chainMessageHas(error, "invalid argument");
}

function isUserKeyRateLimitFailure(error: unknown): boolean {
  return chainMessageHas(error, "User API Key Rate limit exceeded");
}

const TOO_MANY_MEDIA_MARKERS = [
  "request contained too many images or documents",
  "too many images or documents error",
  "too many images and documents",
  "too much media",
];

export function isTooManyImagesOrDocumentsError(error: unknown): boolean {
  return TOO_MANY_MEDIA_MARKERS.some(textMarker => chainMessageHas(error, textMarker));
}

export class CannotTruncatePromptError extends Error {
  declare readonly totalMessages: number;
  declare readonly originalChars: number;
  declare readonly budgetChars: number;

  constructor(message: string, details: { totalMessages: number; originalChars: number; budgetChars: number }) {
    super(message);
    this.name = "CannotTruncatePromptError";
    Object.setPrototypeOf(this, new.target.prototype);
    this.totalMessages = details.totalMessages;
    this.originalChars = details.originalChars;
    this.budgetChars = details.budgetChars;
  }
}

export interface SummarizationRetryOptions {
  readonly transientRetryDelayMs: number;
  readonly enableRetryOutputTokenLimit?: boolean | undefined;
  readonly enableReduceInputsRetry?: boolean | undefined;
  readonly enableRetryNoSummaryResponse?: boolean | undefined;
  readonly enableRetryUncategorizedErrors?: boolean | undefined;
}

export interface SummarizationRetryDirective {
  readonly errorType: string;
  readonly shouldRetry: boolean;
  readonly retryDelayMs: number;
  readonly requestShorterOutput: boolean;
  readonly reduceInputs: boolean;
}

export function getRetryDirective(error: unknown, settings: SummarizationRetryOptions): SummarizationRetryDirective {
  if (error instanceof OutputTokensLimitExceededError || chainHasName(error, "OutputTokensLimitExceededError")) {
    const enableRetryOutputTokenLimit = settings.enableRetryOutputTokenLimit ?? true;
    return {
      errorType: "OutputTokensLimitExceededError",
      shouldRetry: enableRetryOutputTokenLimit,
      retryDelayMs: enableRetryOutputTokenLimit ? settings.transientRetryDelayMs : 0,
      requestShorterOutput: enableRetryOutputTokenLimit,
      reduceInputs: false,
    };
  }
  if (error instanceof InputTokenLimitError || chainHasName(error, "InputTokenLimitError")) {
    const reduceInputs = settings.enableReduceInputsRetry ?? false;
    return { errorType: "InputTokenLimitError", shouldRetry: reduceInputs, retryDelayMs: 0, requestShorterOutput: false, reduceInputs };
  }
  if (chainHasConnectCode(error, CONNECT_CODES.ResourceExhausted) || chainHasName(error, "ResourceExhausted")) {
    if (isOversizedTextFieldsError(error)) {
      const reduceInputs = settings.enableReduceInputsRetry ?? false;
      return { errorType: "InputTooLargeError", shouldRetry: reduceInputs, retryDelayMs: 0, requestShorterOutput: false, reduceInputs };
    }
    if (isInvalidJsonFailure(error)) {
      return { errorType: "InvalidJson", shouldRetry: false, retryDelayMs: 0, requestShorterOutput: false, reduceInputs: false };
    }
    if (isInvalidArgumentFailure(error)) {
      return { errorType: "InvalidArgument", shouldRetry: false, retryDelayMs: 0, requestShorterOutput: false, reduceInputs: false };
    }
    return { errorType: "ResourceExhausted", shouldRetry: true, retryDelayMs: settings.transientRetryDelayMs, requestShorterOutput: false, reduceInputs: false };
  }
  if (chainHasConnectCode(error, CONNECT_CODES.Unavailable) || chainHasName(error, "Unavailable")) {
    return { errorType: "Unavailable", shouldRetry: true, retryDelayMs: settings.transientRetryDelayMs, requestShorterOutput: false, reduceInputs: false };
  }
  if (chainHasConnectCode(error, CONNECT_CODES.Aborted) || chainHasName(error, "UserAbortedError") || chainHasName(error, "AbortError")) {
    return { errorType: "AbortError", shouldRetry: false, retryDelayMs: 0, requestShorterOutput: false, reduceInputs: false };
  }
  if (chainHasName(error, "InteractionListenerStreamClosedError")) {
    return { errorType: "InteractionListenerStreamClosedError", shouldRetry: false, retryDelayMs: 0, requestShorterOutput: false, reduceInputs: false };
  }
  if (chainHasConnectCode(error, CONNECT_CODES.Unauthenticated) || chainHasName(error, "Unauthenticated")) {
    return { errorType: "Unauthenticated", shouldRetry: false, retryDelayMs: 0, requestShorterOutput: false, reduceInputs: false };
  }
  if (chainHasConnectCode(error, CONNECT_CODES.InvalidArgument) || chainHasName(error, "InvalidArgument")) {
    if (isUserKeyRateLimitFailure(error)) {
      return { errorType: "InvalidArgument", shouldRetry: true, retryDelayMs: settings.transientRetryDelayMs, requestShorterOutput: false, reduceInputs: false };
    }
    return { errorType: "InvalidArgument", shouldRetry: false, retryDelayMs: 0, requestShorterOutput: false, reduceInputs: false };
  }
  if (chainHasConnectCode(error, CONNECT_CODES.NotFound) || chainHasName(error, "NotFound") || chainHasName(error, "StringNotFoundError")) {
    return { errorType: "NotFound", shouldRetry: false, retryDelayMs: 0, requestShorterOutput: false, reduceInputs: false };
  }
  if (error instanceof NoSummaryResponseError || chainHasName(error, "NoSummaryResponseError")) {
    return { errorType: "NoSummaryResponseError", shouldRetry: settings.enableRetryNoSummaryResponse ?? false, retryDelayMs: 0, requestShorterOutput: false, reduceInputs: false };
  }
  if (error instanceof CannotTruncatePromptError || chainHasName(error, "CannotTruncatePromptError")) {
    return { errorType: "CannotTruncatePromptError", shouldRetry: false, retryDelayMs: 0, requestShorterOutput: false, reduceInputs: false };
  }
  if (error instanceof Error) {
    const shouldRetry = settings.enableRetryUncategorizedErrors ?? true;
    return {
      errorType: error.name || "UncategorizedError",
      shouldRetry,
      retryDelayMs: shouldRetry ? settings.transientRetryDelayMs : 0,
      requestShorterOutput: false,
      reduceInputs: false,
    };
  }
  return { errorType: "UnknownError", shouldRetry: false, retryDelayMs: 0, requestShorterOutput: false, reduceInputs: false };
}
