import { test } from "node:test"
import assert from "node:assert/strict"

import {
  findLatestImagePart,
  toUserMessageImagePart,
} from "../../source/packages/agent-summarization/latest-image.ts"
import {
  MAX_SUMMARIZATION_PROMPT_CHARS,
  formatOmittedMessagesPreamble,
  truncatePromptFairly,
} from "../../source/packages/agent-summarization/prompt-truncation.ts"
import {
  CannotTruncatePromptError,
  NoSummaryResponseError,
  getRetryDirective,
  isTooManyImagesOrDocumentsError,
} from "../../source/packages/agent-summarization/error-handling.ts"
import { createContext } from "../../source/packages/context/context.ts"
import { InputTokenLimitError, OutputTokensLimitExceededError } from "../../source/packages/chat-inference/prompt-executor.ts"

// ---------------------------------------------------------------------------------------------
// the image a summary has to carry
// ---------------------------------------------------------------------------------------------

test("a bare base64 image becomes the data URL a model call takes", () => {
  const part = toUserMessageImagePart({ image: "aGVsbG8=", mimeType: "image/png" })
  assert.deepEqual(part, { type: "image", image: "data:image/png;base64,aGVsbG8=", mimeType: "image/png" })
})

test("an image that is already a URL is left as it is", () => {
  assert.equal(toUserMessageImagePart({ image: "https://example.test/a.png" }).image, "https://example.test/a.png")
  assert.equal(toUserMessageImagePart({ image: "data:image/jpeg;base64,abc" }).image, "data:image/jpeg;base64,abc")
  assert.equal(toUserMessageImagePart({ image: "blob:abc" }).image, "blob:abc")
})

test("an image with no mime type is assumed to be a PNG", () => {
  assert.match(String(toUserMessageImagePart({ image: "aGVsbG8=" }).image), /^data:image\/png;base64,/)
  assert.match(String(toUserMessageImagePart({ image: "aGVsbG8=", mimeType: "  " }).image), /^data:image\/png;base64,/)
})

test("an image that is not a string is handed over untouched", () => {
  const bytes = new Uint8Array([1, 2, 3])
  const part = toUserMessageImagePart({ image: bytes, mimeType: "image/png" })
  assert.equal(part.image, bytes)
  assert.equal(part.mimeType, "image/png")
  // A mime type that was not there is not invented.
  assert.equal("mimeType" in toUserMessageImagePart({ image: bytes }), false)
})

test("the most recent image is found, wherever it is", () => {
  const fromUser = findLatestImagePart([
    { role: "user", content: [{ type: "text" }, { type: "image", image: "aGVsbG8=", mimeType: "image/png" }] },
  ])
  assert.deepEqual(fromUser, { image: "aGVsbG8=", mimeType: "image/png" })

  const fromTool = findLatestImagePart([
    { role: "tool", content: [{ type: "tool-result", experimental_content: [{ type: "image", data: "d29ybGQ=", mimeType: "image/jpeg" }] }] },
  ])
  assert.deepEqual(fromTool, { image: "d29ybGQ=", mimeType: "image/jpeg" })
})

test("the later of two images wins, and the last one in a message wins", () => {
  const found = findLatestImagePart([
    { role: "user", content: [{ type: "image", image: "first" }] },
    { role: "user", content: [{ type: "image", image: "second" }, { type: "image", image: "third" }] },
  ])
  assert.equal(found?.image, "third")
})

test("a conversation with no image yields nothing", () => {
  assert.equal(findLatestImagePart([{ role: "user", content: "just text" }]), null)
  assert.equal(findLatestImagePart([{ role: "assistant", content: [{ type: "image", image: "ignored" }] }]), null)
  assert.equal(findLatestImagePart([]), null)
  // A tool result whose experimental content is not an image is not one either.
  assert.equal(findLatestImagePart([
    { role: "tool", content: [{ type: "tool-result", experimental_content: [{ type: "text", data: "x" }] }] },
  ]), null)
})

test("an image item without its data is skipped", () => {
  assert.equal(findLatestImagePart([
    { role: "tool", content: [{ type: "tool-result", experimental_content: [{ type: "image" }] }] },
  ]), null)
})

// ---------------------------------------------------------------------------------------------
// fitting a conversation into the summary's room
// ---------------------------------------------------------------------------------------------

const message = (role: string, text: string) => ({ role, text })

test("a conversation that fits is kept whole", () => {
  const serialized = ["one", "two"]
  const result = truncatePromptFairly({
    ctx: createContext(),
    serialized,
    roles: ["user", "assistant"],
    suffix: "",
    charBudget: 1_000,
  })
  assert.deepEqual(result, { resultParts: serialized, droppedCount: 0, truncatedCount: 0, fullCount: 2 })
})

test("the room is shared fairly, and a small message gives back what it did not need", () => {
  const big = "x".repeat(1_000)
  const small = "y".repeat(10)
  const result = truncatePromptFairly({
    ctx: createContext(),
    serialized: [small, big],
    roles: ["user", "assistant"],
    suffix: "",
    charBudget: 1_000,
  })
  assert.equal(result !== null, true)
  // The small message is kept whole, and the room it did not need goes to the large one — which is still
  // cut, because a thousand characters do not fit in what is left.
  assert.equal(result?.resultParts[0], small)
  assert.equal(result?.fullCount, 1)
  assert.equal(result?.truncatedCount, 1)
  assert.match(String(result?.resultParts[1]), /\[\.\.\. truncated, 1000 chars\]$/)
})

test("a budget that leaves nothing useful drops the message instead of cutting it", () => {
  const result = truncatePromptFairly({
    ctx: createContext(),
    serialized: ["y".repeat(10), "x".repeat(1_000)],
    roles: ["user", "assistant"],
    suffix: "",
    charBudget: 300,
  })
  // What is left after the omitted-messages preamble is below the useful size, so the message is reported
  // as omitted rather than reduced to a fragment.
  assert.equal(result?.droppedCount, 1)
  assert.equal(result?.truncatedCount, 0)
  assert.match(String(result?.resultParts[1]), /^\[omitted assistant message, 1000 chars\]$/)
})

test("a message cut below a useful size is dropped with a note instead", () => {
  const result = truncatePromptFairly({
    ctx: createContext(),
    serialized: ["x".repeat(500), "y".repeat(500)],
    roles: ["user", "assistant"],
    suffix: "",
    charBudget: 100,
    minUsefulChars: 200,
  })
  assert.equal(result, null)
})

test("a message that cannot be kept usefully is replaced by what was lost", () => {
  const result = truncatePromptFairly({
    ctx: createContext(),
    serialized: ["x".repeat(5_000), "y".repeat(5_000)],
    roles: ["user", "assistant"],
    suffix: "",
    charBudget: 400,
    minUsefulChars: 100,
  })
  // Each message gets a useful share, so both are cut rather than dropped.
  assert.equal(result?.truncatedCount, 2)
  assert.equal(result?.droppedCount, 0)
  assert.match(String(result?.resultParts[0]), /\[\.\.\. truncated, 5000 chars\]$/)
})

test("the user's own words are what survives a truncation", () => {
  const entry = `a lot of context ${"c".repeat(1_000)} <user_query>what does this do?</user_query>`
  const result = truncatePromptFairly({
    ctx: createContext(),
    serialized: [entry],
    roles: ["user"],
    suffix: "",
    charBudget: 600,
  })
  assert.match(String(result?.resultParts[0]), /<user_query>what does this do\?<\/user_query>/)
  assert.match(String(result?.resultParts[0]), /\[\.\.\. truncated, \d+ chars\]$/)
  // The question is what the cut kept, and the context around it is what gave way.
  assert.equal(String(result?.resultParts[0]).includes("c".repeat(1_000)), false)
})

test("a truncation that would keep nothing is reported as nothing rather than an empty prompt", () => {
  const result = truncatePromptFairly({
    ctx: createContext(),
    serialized: ["x".repeat(1_000)],
    roles: ["assistant"],
    suffix: "",
    charBudget: 0,
  })
  assert.equal(result, null)
})

test("the preamble says how many messages were left out and where the history is", () => {
  assert.equal(
    formatOmittedMessagesPreamble(3),
    "[3 message(s) omitted due to size limits; omitted content may appear anywhere in the conversation. See transcript file for full history.]\n\n",
  )
})

test("the prompt's own ceiling is a constant the caller can see", () => {
  assert.equal(MAX_SUMMARIZATION_PROMPT_CHARS, 3_200_000)
})

// ---------------------------------------------------------------------------------------------
// what a failed summarization means
// ---------------------------------------------------------------------------------------------

const options = { transientRetryDelayMs: 250 }

test("an output limit is retried with a shorter answer asked for", () => {
  const directive = getRetryDirective(new OutputTokensLimitExceededError(), options)
  assert.deepEqual(directive, {
    errorType: "OutputTokensLimitExceededError",
    shouldRetry: true,
    retryDelayMs: 250,
    requestShorterOutput: true,
    reduceInputs: false,
  })
})

test("an input limit is only retried when the session asked for less input", () => {
  const without = getRetryDirective(new InputTokenLimitError(), options)
  assert.equal(without.shouldRetry, false)
  assert.equal(without.reduceInputs, false)

  const with_ = getRetryDirective(new InputTokenLimitError(), { ...options, enableReduceInputsRetry: true })
  assert.equal(with_.shouldRetry, true)
  assert.equal(with_.reduceInputs, true)
  assert.equal(with_.errorType, "InputTokenLimitError")
})

test("a code carried on the error is what decides, even when the message says nothing", () => {
  const resourceExhausted = Object.assign(new Error("something went wrong"), { code: 8 })
  const directive = getRetryDirective(resourceExhausted, options)
  assert.equal(directive.errorType, "ResourceExhausted")
  assert.equal(directive.shouldRetry, true)
  assert.equal(directive.retryDelayMs, 250)
})

test("a resource failure that was really about the input is read for what it said", () => {
  const tooLarge = Object.assign(new Error("request contains text fields that are too large"), { code: 8 })
  const directive = getRetryDirective(tooLarge, { ...options, enableReduceInputsRetry: true })
  assert.equal(directive.errorType, "InputTooLargeError")
  assert.equal(directive.reduceInputs, true)

  const invalidJson = Object.assign(new Error("the body is not valid JSON"), { code: 8 })
  assert.equal(getRetryDirective(invalidJson, options).shouldRetry, false)
  assert.equal(getRetryDirective(invalidJson, options).errorType, "InvalidJson")

  const invalidArgument = Object.assign(new Error("invalid argument: temperature"), { code: 8 })
  assert.equal(getRetryDirective(invalidArgument, options).errorType, "InvalidArgument")
})

test("a failure wrapped around another is read through its cause", () => {
  const inner = Object.assign(new Error("unavailable"), { code: 14 })
  const outer = new Error("the call failed", { cause: inner })
  assert.equal(getRetryDirective(outer, options).errorType, "Unavailable")

  // A cause chain that loops is walked once rather than forever.
  const looping = new Error("looping")
  ;(looping as { cause?: unknown }).cause = looping
  assert.equal(getRetryDirective(looping, options).errorType, "Error")
})

test("an abort is never retried, because there is nobody left to answer", () => {
  const aborted = Object.assign(new Error("aborted"), { code: 10 })
  assert.deepEqual(getRetryDirective(aborted, options), {
    errorType: "AbortError",
    shouldRetry: false,
    retryDelayMs: 0,
    requestShorterOutput: false,
    reduceInputs: false,
  })
  const named = Object.assign(new Error("stopped"), { name: "AbortError" })
  assert.equal(getRetryDirective(named, options).shouldRetry, false)
})

test("a closed listener stream is not retried either", () => {
  const closed = Object.assign(new Error("closed"), { name: "InteractionListenerStreamClosedError" })
  assert.equal(getRetryDirective(closed, options).shouldRetry, false)
})

test("a missing summary is only retried when the session asked for it", () => {
  const error = new NoSummaryResponseError()
  assert.equal(error.name, "NoSummaryResponseError")
  assert.equal(getRetryDirective(error, options).shouldRetry, false)
  assert.equal(getRetryDirective(error, { ...options, enableRetryNoSummaryResponse: true }).shouldRetry, true)
})

test("an authentication failure is reported rather than retried", () => {
  const unauthenticated = Object.assign(new Error("no credentials"), { code: 16 })
  assert.equal(getRetryDirective(unauthenticated, options).errorType, "Unauthenticated")
  assert.equal(getRetryDirective(unauthenticated, options).shouldRetry, false)
})

test("a rate limit is the one invalid argument that is worth trying again", () => {
  const rateLimited = Object.assign(new Error("User API Key Rate limit exceeded"), { code: 3 })
  const directive = getRetryDirective(rateLimited, options)
  assert.equal(directive.errorType, "InvalidArgument")
  assert.equal(directive.shouldRetry, true)
})

test("a prompt that cannot be truncated is reported rather than retried", () => {
  const error = new CannotTruncatePromptError("nothing left", { totalMessages: 10, originalChars: 100_000, budgetChars: 5_000 })
  assert.equal(error.name, "CannotTruncatePromptError")
  assert.equal(error.totalMessages, 10)
  assert.equal(error.budgetChars, 5_000)
  assert.equal(getRetryDirective(error, options).shouldRetry, false)
})

test("a failure nobody classified is retried once, and can be turned off", () => {
  const uncategorized = new Error("something new")
  assert.equal(getRetryDirective(uncategorized, options).shouldRetry, true)
  assert.equal(getRetryDirective(uncategorized, options).retryDelayMs, 250)
  assert.equal(getRetryDirective(uncategorized, { ...options, enableRetryUncategorizedErrors: false }).shouldRetry, false)

  // A value that is not an error at all is not retried.
  assert.deepEqual(getRetryDirective("a string", options), {
    errorType: "UnknownError",
    shouldRetry: false,
    retryDelayMs: 0,
    requestShorterOutput: false,
    reduceInputs: false,
  })
})

test("too much media is recognized however the provider worded it", () => {
  assert.equal(isTooManyImagesOrDocumentsError(new Error("request contained too many images or documents")), true)
  assert.equal(isTooManyImagesOrDocumentsError(new Error("TOO MUCH MEDIA")), true)
  assert.equal(isTooManyImagesOrDocumentsError(new Error("too many images and documents")), true)
  assert.equal(isTooManyImagesOrDocumentsError(new Error("something else")), false)
  // It is read through a cause as well.
  assert.equal(isTooManyImagesOrDocumentsError(new Error("wrapped", { cause: new Error("too much media") })), true)
})
