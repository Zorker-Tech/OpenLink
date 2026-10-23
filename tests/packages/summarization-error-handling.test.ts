/**
 * What a failed summarization means: the retry directive per failure class, its settings toggles, the media predicate
 * and the exported error classes.
 */
import { test } from "node:test";
import assert from "node:assert/strict";

import {
  CannotTruncatePromptError,
  NoSummaryResponseError,
  getRetryDirective,
  isTooManyImagesOrDocumentsError,
} from "../../source/packages/agent-summarization/error-handling.ts";
import { InputTokenLimitError, OutputTokensLimitExceededError } from "../../source/packages/chat-inference/prompt-executor.ts";

const settings = (overrides: Record<string, unknown> = {}) => ({ transientRetryDelayMs: 250, ...overrides });
const directive = (error: unknown, overrides: Record<string, unknown> = {}) => getRetryDirective(error, settings(overrides));
const named = (name: string, message = "boom") => { const error = new Error(message); error.name = name; return error; };
const coded = (code: number, message = "coded") => Object.assign(new Error(message), { code });
const chained = (outer: unknown, cause: unknown) => Object.assign(outer as object, { cause });

const retryNow = (errorType: string, delayMs = 250) => ({ errorType, shouldRetry: true, retryDelayMs: delayMs, requestShorterOutput: false, reduceInputs: false });
const noRetry = (errorType: string) => ({ errorType, shouldRetry: false, retryDelayMs: 0, requestShorterOutput: false, reduceInputs: false });

test("the output-token limit asks for a shorter answer, and can be turned off", () => {
  assert.deepEqual(directive(new OutputTokensLimitExceededError("too long")), { errorType: "OutputTokensLimitExceededError", shouldRetry: true, retryDelayMs: 250, requestShorterOutput: true, reduceInputs: false });
  assert.deepEqual(directive(new OutputTokensLimitExceededError("too long"), { enableRetryOutputTokenLimit: false }), noRetry("OutputTokensLimitExceededError"));
  assert.deepEqual(directive(named("OutputTokensLimitExceededError")), { errorType: "OutputTokensLimitExceededError", shouldRetry: true, retryDelayMs: 250, requestShorterOutput: true, reduceInputs: false });
});

test("the input-token limit only retries when the session asked for less input", () => {
  assert.deepEqual(directive(new InputTokenLimitError("too long")), noRetry("InputTokenLimitError"));
  assert.deepEqual(directive(new InputTokenLimitError("too long"), { enableReduceInputsRetry: true }), { errorType: "InputTokenLimitError", shouldRetry: true, retryDelayMs: 0, requestShorterOutput: false, reduceInputs: true });
  assert.deepEqual(directive(named("InputTokenLimitError")), noRetry("InputTokenLimitError"));
});

test("resource exhaustion is retried, with the oversized, invalid-json and invalid-argument variants special-cased", () => {
  assert.deepEqual(directive(coded(8)), retryNow("ResourceExhausted"));
  assert.deepEqual(directive(named("ResourceExhausted")), retryNow("ResourceExhausted"));
  assert.deepEqual(directive(chained(named("ResourceExhausted"), new Error("request contains text fields that are too large"))), noRetry("InputTooLargeError"));
  assert.deepEqual(directive(chained(named("ResourceExhausted"), new Error("request contains text fields that are too large")), { enableReduceInputsRetry: true }), { errorType: "InputTooLargeError", shouldRetry: true, retryDelayMs: 0, requestShorterOutput: false, reduceInputs: true });
  assert.deepEqual(directive(chained(named("ResourceExhausted"), new Error("not valid JSON"))), noRetry("InvalidJson"));
  assert.deepEqual(directive(chained(named("ResourceExhausted"), new Error("invalid JSON"))), noRetry("InvalidJson"));
  assert.deepEqual(directive(chained(named("ResourceExhausted"), new Error("invalid argument: x"))), noRetry("InvalidArgument"));
});

test("transient, aborting, unauthenticated, invalid-argument and not-found failures each get their own answer", () => {
  assert.deepEqual(directive(coded(14)), retryNow("Unavailable"));
  assert.deepEqual(directive(named("Unavailable")), retryNow("Unavailable"));
  assert.deepEqual(directive(coded(10)), noRetry("AbortError"));
  assert.deepEqual(directive(named("UserAbortedError")), noRetry("AbortError"));
  assert.deepEqual(directive(named("AbortError")), noRetry("AbortError"));
  assert.deepEqual(directive(named("InteractionListenerStreamClosedError")), noRetry("InteractionListenerStreamClosedError"));
  assert.deepEqual(directive(coded(16)), noRetry("Unauthenticated"));
  assert.deepEqual(directive(named("Unauthenticated")), noRetry("Unauthenticated"));
  assert.deepEqual(directive(coded(3)), noRetry("InvalidArgument"));
  assert.deepEqual(directive(named("InvalidArgument")), noRetry("InvalidArgument"));
  assert.deepEqual(directive(chained(coded(3), new Error("User API Key Rate limit exceeded"))), retryNow("InvalidArgument"));
  assert.deepEqual(directive(coded(5)), noRetry("NotFound"));
  assert.deepEqual(directive(named("NotFound")), noRetry("NotFound"));
  assert.deepEqual(directive(named("StringNotFoundError")), noRetry("NotFound"));
});

test("the no-summary and cannot-truncate failures have their own settings", () => {
  assert.deepEqual(directive(new NoSummaryResponseError()), noRetry("NoSummaryResponseError"));
  assert.deepEqual(directive(new NoSummaryResponseError(), { enableRetryNoSummaryResponse: true }), { errorType: "NoSummaryResponseError", shouldRetry: true, retryDelayMs: 0, requestShorterOutput: false, reduceInputs: false });
  assert.deepEqual(directive(new CannotTruncatePromptError("too big", { totalMessages: 3, originalChars: 100, budgetChars: 10 })), noRetry("CannotTruncatePromptError"));
  assert.deepEqual(directive(named("NoSummaryResponseError")), noRetry("NoSummaryResponseError"));
});

test("an uncategorized failure is retried by default and keeps its own name", () => {
  assert.deepEqual(directive(named("SomethingElse")), retryNow("SomethingElse"));
  assert.deepEqual(directive(named("SomethingElse"), { enableRetryUncategorizedErrors: false }), { ...noRetry("SomethingElse") });
  assert.deepEqual(directive(named("")), retryNow("UncategorizedError"));
  assert.deepEqual(directive("plain failure"), noRetry("UnknownError"));
  assert.deepEqual(directive(null), noRetry("UnknownError"));
  assert.deepEqual(directive({ code: 8 }), retryNow("ResourceExhausted"));
});

test("a cause chain is walked without looping", () => {
  assert.deepEqual(directive(chained(new Error("outer"), chained(new Error("middle"), coded(8)))), retryNow("ResourceExhausted"));
  const first = new Error("a");
  const second = Object.assign(new Error("b"), { cause: first });
  Object.assign(first, { cause: second });
  assert.deepEqual(directive(first), retryNow("Error"));
});

test("the media predicate reads the known markers, including through a cause chain", () => {
  for (const message of [
    "request contained too many images or documents",
    "too many images or documents error",
    "too many images and documents",
    "too much media",
    "REQUEST CONTAINED TOO MANY IMAGES OR DOCUMENTS",
  ]) {
    assert.equal(isTooManyImagesOrDocumentsError(new Error(message)), true);
  }
  assert.equal(isTooManyImagesOrDocumentsError(new Error("unrelated")), false);
  assert.equal(isTooManyImagesOrDocumentsError(chained(new Error("outer"), new Error("too much media"))), true);
  assert.equal(isTooManyImagesOrDocumentsError("too much media"), false);
});

test("the exported error classes keep their names, messages and fields", () => {
  const noSummary = new NoSummaryResponseError();
  assert.equal(noSummary.name, "NoSummaryResponseError");
  assert.equal(noSummary.message, "No assistant response received");
  assert.equal(noSummary instanceof Error, true);
  const cannotTruncate = new CannotTruncatePromptError("msg", { totalMessages: 4, originalChars: 20, budgetChars: 5 });
  assert.equal(cannotTruncate.name, "CannotTruncatePromptError");
  assert.equal(cannotTruncate.totalMessages, 4);
  assert.equal(cannotTruncate.originalChars, 20);
  assert.equal(cannotTruncate.budgetChars, 5);
});

test("a failure that only carries the cannot-truncate name is still not retried", () => {
  assert.deepEqual(directive(named("CannotTruncatePromptError")), noRetry("CannotTruncatePromptError"));
});
