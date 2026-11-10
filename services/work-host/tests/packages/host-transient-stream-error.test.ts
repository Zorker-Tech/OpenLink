import assert from "node:assert/strict";
import { describe, it } from "node:test";

import {
  DEFAULT_AUTOMATION_STREAM_RETRY_BASE_DELAY_MS,
  DEFAULT_AUTOMATION_STREAM_RETRY_MAX_ATTEMPTS,
  DEFAULT_AUTOMATION_STREAM_RETRY_MAX_DELAY_MS,
  DEFAULT_FIRST_TOKEN_STALL_DEADLINE_MS,
  DEFAULT_OVERLOAD_STREAM_RETRY_BASE_DELAY_MS,
  DEFAULT_OVERLOAD_STREAM_RETRY_MAX_ATTEMPTS,
  DEFAULT_OVERLOAD_STREAM_RETRY_MAX_DELAY_MS,
  FirstTokenStallError,
  MAX_SERVER_RETRY_AFTER_MS,
  TRANSIENT_ERRNO_CODES,
  TRANSIENT_MESSAGE_TOKENS,
  computeBackoffDelayMs,
  computeServerPacedDelayMs,
  isConversationTooLargeRefusal,
  isContextOverflowDeadEnd,
  isFirstTokenStallError,
  isProviderCapacityError,
  isRetryableProviderError,
  isTransientStreamError,
  messageLooksTransient,
  resolveAutomationStreamRetryPolicy,
  resolveFirstTokenStallDeadlineMs,
  resolveOverloadStreamRetryPolicy,
  runWithTransientRetry,
  serverRetryAfterMsFromError,
  shouldRetryTurnAttempt,
  type RetryPolicy,
} from "../../source/host/runner/transient-stream-error.ts";

const errorWith = (fields: Record<string, unknown>) => Object.assign(new Error("failed"), fields);

describe("what makes a stream error transient", () => {
  it("knows the errno codes that mean the connection went away, in any case", () => {
    for (const code of ["ECONNRESET", "econnreset", "ETIMEDOUT", "EPIPE", "ENETUNREACH", "EAI_AGAIN"]) {
      assert.equal(isTransientStreamError({ code }), true, code);
    }
    for (const code of ["EACCES", "ENOENT", "EINVAL"]) assert.equal(isTransientStreamError({ code }), false, code);
    assert.equal(TRANSIENT_ERRNO_CODES.size, 10);
  });

  it("reads the message when the code says nothing", () => {
    for (const message of ["socket hang up", "Premature close", "Connection reset by peer", "the operation was aborted", "[UNAVAILABLE]"]) {
      assert.equal(isTransientStreamError({ message }), true, message);
    }
    for (const message of ["permission denied", "model not found"]) assert.equal(isTransientStreamError({ message }), false, message);
  });

  it("takes a bare string as its own message, and reads its tokens case-insensitively", () => {
    assert.equal(isTransientStreamError("read ECONNRESET"), true);
    assert.equal(isTransientStreamError("everything is fine"), false);
    assert.equal(messageLooksTransient("SOCKET HANG UP"), true);
    assert.equal(TRANSIENT_MESSAGE_TOKENS.every((token) => token === token.toLowerCase()), true);
  });

  it("follows the cause chain and an aggregate's errors", () => {
    assert.equal(isTransientStreamError({ cause: { cause: { code: "EPIPE" } } }), true);
    assert.equal(isTransientStreamError({ errors: [{ message: "unrelated" }, { code: "ETIMEDOUT" }] }), true);
    assert.equal(isTransientStreamError({ cause: { code: "EACCES" } }), false);
  });

  it("ends a chain that points back at itself", () => {
    const looped: Record<string, unknown> = { code: "EACCES" };
    looped["cause"] = looped;
    assert.equal(isTransientStreamError(looped), false);
  });
});

describe("failures a retry cannot help", () => {
  it("recognises a conversation that is too large", () => {
    assert.equal(isConversationTooLargeRefusal({ isConversationTooLarge: true }), true);
    assert.equal(isConversationTooLargeRefusal({ cause: { isConversationTooLarge: true } }), true);
    assert.equal(isConversationTooLargeRefusal({ isConversationTooLarge: false }), false);
  });

  it("recognises the two shapes of running out of context for good", () => {
    assert.equal(isContextOverflowDeadEnd({ name: "InputTokenLimitError" }), true);
    assert.equal(isContextOverflowDeadEnd({ isStepRetriesExhausted: true, reason: "summarization-retries" }), true);
    assert.equal(isContextOverflowDeadEnd({ name: "StepRetriesExhaustedError", reason: "summarization-retries" }), true);
    assert.equal(isContextOverflowDeadEnd({ name: "StepRetriesExhaustedError", reason: "something-else" }), false);
  });

  it("refuses to retry a transient error that also says it is terminal", () => {
    assert.equal(isRetryableProviderError(errorWith({ code: "ECONNRESET" })), true);
    for (const terminal of [{ terminal: true }, { name: "NonRetriableError" }, { name: "ActionRequiredError" }]) {
      assert.equal(isRetryableProviderError(errorWith({ code: "ECONNRESET", ...terminal })), false, JSON.stringify(terminal));
    }
  });

  it("refuses to retry a conversation that is too large even when the error says it is retryable", () => {
    assert.equal(isRetryableProviderError({ retryable: true, isConversationTooLarge: true }), false);
    assert.equal(isRetryableProviderError({ code: "ECONNRESET", name: "InputTokenLimitError" }), false);
  });

  it("refuses to retry an error that never said it was retryable", () => {
    assert.equal(isRetryableProviderError(new Error("plain")), false);
    assert.equal(isRetryableProviderError({ retryable: true }), true);
    assert.equal(isRetryableProviderError({ cause: { retryable: true } }), true);
  });
});

describe("a provider that is out of capacity", () => {
  it("is only a capacity error when it is retryable at all", () => {
    assert.equal(isProviderCapacityError({ displayInfo: { connectCode: "Unavailable" } }), false, "not retryable, so not capacity");
    assert.equal(isProviderCapacityError({ retryable: true, displayInfo: { connectCode: "Unavailable" } }), true);
  });

  it("reads the transport's own words for it", () => {
    for (const displayInfo of [{ connectCode: "Unavailable" }, { connectCode: 14 }, { connectCode: "ResourceExhausted", errorCode: "RESOURCE_EXHAUSTED" }, { connectCode: 8, errorCode: 8 }]) {
      assert.equal(isProviderCapacityError({ retryable: true, displayInfo }), true, JSON.stringify(displayInfo));
    }
    for (const displayInfo of [{ connectCode: "Other" }, { connectCode: "ResourceExhausted", errorCode: "OTHER" }, null, "nope"]) {
      assert.equal(isProviderCapacityError({ retryable: true, displayInfo }), false, JSON.stringify(displayInfo));
    }
  });
});

describe("a provider that never started responding", () => {
  it("says how long it waited, in whole seconds", () => {
    assert.equal(new FirstTokenStallError(150_000).message, "The model provider did not start responding within 150s.");
    assert.equal(new FirstTokenStallError(1_400).message.includes("1s"), true);
    assert.equal(new FirstTokenStallError(1).name, "FirstTokenStallError");
  });

  it("is recognised as itself, by name, or by the flag it carries", () => {
    assert.equal(isFirstTokenStallError(new FirstTokenStallError(1)), true);
    assert.equal(isFirstTokenStallError({ name: "FirstTokenStallError" }), true);
    assert.equal(isFirstTokenStallError({ isFirstTokenStall: true }), true);
    assert.equal(isFirstTokenStallError({ name: "SomethingElse" }), false);
    assert.equal(isFirstTokenStallError("FirstTokenStallError"), false);
  });
});

describe("whether a turn is worth running again", () => {
  const base = { canceled: false, error: errorWith({ code: "ECONNRESET" }), streamOutputProduced: false, resumeCheckpointAvailable: false };

  it("retries a transient failure when nothing was produced yet", () => {
    assert.equal(shouldRetryTurnAttempt(base), true);
  });

  it("will not retry a turn that was canceled, or one whose transcript could not be appended", () => {
    assert.equal(shouldRetryTurnAttempt({ ...base, canceled: true }), false);
    assert.equal(shouldRetryTurnAttempt({ ...base, error: { isTranscriptAppendAfterCheckpointError: true } }), false);
    assert.equal(shouldRetryTurnAttempt({ ...base, error: { isTranscriptAppendAfterCheckpointError: true, code: "ECONNRESET" } }), false, "even when the failure behind it is transient");
  });

  it("retries output it can resume, and never output it would write twice", () => {
    assert.equal(shouldRetryTurnAttempt({ ...base, streamOutputProduced: true, resumeCheckpointAvailable: false }), false);
    assert.equal(shouldRetryTurnAttempt({ ...base, streamOutputProduced: true, resumeCheckpointAvailable: true }), true);
  });

  it("retries a first-token stall on the same terms", () => {
    assert.equal(shouldRetryTurnAttempt({ ...base, error: new FirstTokenStallError(1) }), true);
    assert.equal(shouldRetryTurnAttempt({ ...base, error: new FirstTokenStallError(1), streamOutputProduced: true }), false);
  });

  it("falls back to the automation's own answer for anything else", () => {
    assert.equal(shouldRetryTurnAttempt({ ...base, error: new Error("plain") }), false);
    assert.equal(shouldRetryTurnAttempt({ ...base, error: new Error("plain"), automationIsRetryable: () => true }), true);
    assert.equal(shouldRetryTurnAttempt({ ...base, error: new Error("plain"), automationIsRetryable: () => false }), false);
  });
});

describe("how long to wait", () => {
  it("waits somewhere in the second half of the doubling window", () => {
    const attempt = (n: number, random: number) => computeBackoffDelayMs({ attempt: n, baseDelayMs: 1_000, maxDelayMs: 60_000, random: () => random });
    assert.equal(attempt(1, 0), 500);
    assert.equal(attempt(1, 1), 1_000);
    assert.equal(attempt(2, 0), 1_000);
    assert.equal(attempt(2, 1), 2_000);
    assert.equal(attempt(3, 1), 4_000);
  });

  it("never waits longer than the cap, and never less than the base allows", () => {
    const capped = computeBackoffDelayMs({ attempt: 20, baseDelayMs: 1_000, maxDelayMs: 5_000, random: () => 1 });
    assert.equal(capped, 5_000);
    assert.equal(computeBackoffDelayMs({ attempt: 5, baseDelayMs: 0, maxDelayMs: 5_000, random: () => 1 }), 0);
    assert.equal(computeBackoffDelayMs({ attempt: 0, baseDelayMs: 1_000, maxDelayMs: 5_000, random: () => 1 }), 1_000, "an attempt below one behaves like the first");
    // A window that would outgrow the cap is cut at the cap before it is halved, not after: the wait is the cap's
    // second half, not half of the uncapped doubling.
    assert.equal(computeBackoffDelayMs({ attempt: 3, baseDelayMs: 750, maxDelayMs: 1_000, random: () => 0 }), 500);
  });

  it("waits as long as the server asked, jittered by up to half of that, and never past the cap", () => {
    assert.equal(computeServerPacedDelayMs({ retryAfterMs: 1_000, random: () => 0 }), 1_000);
    assert.equal(computeServerPacedDelayMs({ retryAfterMs: 1_000, random: () => 1 }), 1_500);
    assert.equal(computeServerPacedDelayMs({ retryAfterMs: 30_000, random: () => 1 }), MAX_SERVER_RETRY_AFTER_MS);
    assert.equal(MAX_SERVER_RETRY_AFTER_MS, 30_000);
  });

  it("finds the wait a server asked for in the error or in what it wraps", () => {
    assert.equal(serverRetryAfterMsFromError({ metadata: new Map([["retry-after", "3"]]) }), 3_000);
    assert.equal(serverRetryAfterMsFromError({ metadata: new Map([["retry-after", 2.5]]) }), 2_500);
    assert.equal(serverRetryAfterMsFromError({ metadata: { get: () => "1.5" } }), 1_500);
    assert.equal(serverRetryAfterMsFromError({ cause: { metadata: new Map([["retry-after", "7"]]) } }), 7_000);
    assert.equal(serverRetryAfterMsFromError({ metadata: new Map([["retry-after", "100"]]) }), MAX_SERVER_RETRY_AFTER_MS);
  });

  it("ignores a wait that is missing, empty, negative or not a number", () => {
    for (const raw of [undefined, null, "", "-1", "abc"]) {
      assert.equal(serverRetryAfterMsFromError({ metadata: new Map([["retry-after", raw]]) }), undefined, String(raw));
    }
    assert.equal(serverRetryAfterMsFromError({ metadata: { notGet: true } }), undefined);
    assert.equal(serverRetryAfterMsFromError(new Error("plain")), undefined);
  });
});

describe("running something that may fail transiently", () => {
  /** Runs a scripted sequence of outcomes, recording every wait and every retry decision. */
  async function run(outcomes: unknown[], policy: Partial<RetryPolicy>): Promise<{ value?: unknown; thrown?: unknown; log: string[] }> {
    const log: string[] = [];
    let index = 0;
    try {
      const value = await runWithTransientRetry(
        async () => {
          const outcome = outcomes[index++] ?? "ran out";
          if (outcome instanceof Error || (typeof outcome === "object" && outcome !== null)) throw outcome;
          return outcome;
        },
        {
          maxAttempts: 3,
          baseDelayMs: 100,
          maxDelayMs: 1_000,
          random: () => 0.5,
          sleep: async (delayMs) => {
            log.push(`sleep ${delayMs}`);
          },
          onRetry: (info) => log.push(`retry ${info.attempt} after ${info.delayMs}${info.serverPaced ? " (server)" : ""}`),
          ...policy,
        },
      );
      return { value, log };
    } catch (error) {
      return { thrown: error, log };
    }
  }

  it("answers with the first result that works, waiting between attempts", async () => {
    const result = await run(["ok"], {});
    assert.deepEqual(result, { value: "ok", log: [] });
    const retried = await run([new Error("socket hang up"), "ok"], {});
    assert.equal(retried.value, "ok");
    assert.deepEqual(retried.log, ["retry 1 after 75", "sleep 75"]);
  });

  it("gives up after its last attempt and throws the failure it ended on", async () => {
    const result = await run([new Error("socket hang up"), new Error("socket hang up"), new Error("socket hang up"), "never"], {});
    assert.equal((result.thrown as Error).message, "socket hang up");
    assert.deepEqual(result.log.filter((line) => line.startsWith("retry")), ["retry 1 after 75", "retry 2 after 150"]);
  });

  it("does not retry what it cannot call transient", async () => {
    const result = await run([new Error("permission denied"), "never"], {});
    assert.equal((result.thrown as Error).message, "permission denied");
    assert.deepEqual(result.log, []);
  });

  it("takes the server's word for how long to wait when the failure carries one", async () => {
    const result = await run([{ code: "ECONNRESET", metadata: new Map([["retry-after", "2"]]) }, "ok"], {});
    assert.equal(result.value, "ok");
    assert.deepEqual(result.log, ["retry 1 after 2500 (server)", "sleep 2500"]);
  });

  it("takes one attempt when the policy asks for none", async () => {
    const result = await run([new Error("socket hang up"), "never"], { maxAttempts: 0 });
    assert.equal((result.thrown as Error).message, "socket hang up");
    assert.deepEqual(result.log, []);
  });

  it("asks a policy's own question when it has one", async () => {
    const retried = await run([new Error("permission denied"), "ok"], { isRetryable: () => true });
    assert.equal(retried.value, "ok");
    const refused = await run([new Error("socket hang up"), "never"], { isRetryable: () => false });
    assert.equal((refused.thrown as Error).message, "socket hang up");
  });
});

describe("the numbers these policies start from", () => {
  it("names the defaults the build ships with", () => {
    assert.equal(DEFAULT_AUTOMATION_STREAM_RETRY_MAX_ATTEMPTS, 4);
    assert.equal(DEFAULT_AUTOMATION_STREAM_RETRY_BASE_DELAY_MS, 1_000);
    assert.equal(DEFAULT_AUTOMATION_STREAM_RETRY_MAX_DELAY_MS, 15_000);
    assert.equal(DEFAULT_OVERLOAD_STREAM_RETRY_MAX_ATTEMPTS, 3);
    assert.equal(DEFAULT_OVERLOAD_STREAM_RETRY_BASE_DELAY_MS, 750);
    assert.equal(DEFAULT_OVERLOAD_STREAM_RETRY_MAX_DELAY_MS, 6_000);
    assert.equal(DEFAULT_FIRST_TOKEN_STALL_DEADLINE_MS, 150_000);
  });

  it("reads overrides from the environment, and falls back when a value is missing or below its floor", () => {
    const automation = resolveAutomationStreamRetryPolicy({}, { SLATE_AUTOMATION_STREAM_RETRY_ATTEMPTS: "7", SLATE_AUTOMATION_STREAM_RETRY_BASE_MS: " 250 ", SLATE_AUTOMATION_STREAM_RETRY_MAX_MS: "abc" });
    assert.deepEqual(automation, { maxAttempts: 7, baseDelayMs: 250, maxDelayMs: 15_000 });
    assert.equal(resolveAutomationStreamRetryPolicy({}, { SLATE_AUTOMATION_STREAM_RETRY_ATTEMPTS: "0" }).maxAttempts, 4, "an attempt count below one falls back");
    assert.equal(resolveOverloadStreamRetryPolicy({}, { SLATE_OVERLOAD_STREAM_RETRY_MAX_MS: "2500" }).maxDelayMs, 2_500);
    assert.equal(resolveFirstTokenStallDeadlineMs({ SLATE_FIRST_TOKEN_STALL_DEADLINE_MS: "90000" }), 90_000);
    assert.equal(resolveFirstTokenStallDeadlineMs({ SLATE_FIRST_TOKEN_STALL_DEADLINE_MS: "-5" }), 150_000);
  });

  it("lets an override win over the environment", () => {
    const policy = resolveAutomationStreamRetryPolicy({ maxAttempts: 9 }, { SLATE_AUTOMATION_STREAM_RETRY_ATTEMPTS: "2" });
    assert.equal(policy.maxAttempts, 9);
  });
});
