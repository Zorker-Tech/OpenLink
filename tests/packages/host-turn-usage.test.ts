import assert from "node:assert/strict";
import { describe, it } from "node:test";

import * as usageModule from "../../source/host/runner/turn-usage.ts";
import { addTokenCounts, mergeTurnUsage, toSafeTokenCount, totalInputTokens, turnUsageFromTurnEnded } from "../../source/host/runner/turn-usage.ts";

const max = BigInt(Number.MAX_SAFE_INTEGER);

describe("token counts", () => {
  it("are clamped into what a number holds without losing precision", () => {
    assert.equal(toSafeTokenCount(0n), 0);
    assert.equal(toSafeTokenCount(1n), 1);
    assert.equal(toSafeTokenCount(-1n), 0, "a negative count is nothing");
    assert.equal(toSafeTokenCount(max - 1n), Number.MAX_SAFE_INTEGER - 1);
    assert.equal(toSafeTokenCount(max), Number.MAX_SAFE_INTEGER);
    assert.equal(toSafeTokenCount(max + 1n), Number.MAX_SAFE_INTEGER, "the boundary itself is already the cap");
    assert.equal(toSafeTokenCount(10n ** 30n), Number.MAX_SAFE_INTEGER);
    assert.deepEqual(Object.keys(usageModule).sort(), [
      "addTokenCounts",
      "mergeTurnUsage",
      "toSafeTokenCount",
      "totalInputTokens",
      "turnUsageFromTurnEnded",
    ]);
  });

  it("are read off a turn-ended event, with absent kinds counting zero and reasoning left out when it was not reported", () => {
    assert.equal(turnUsageFromTurnEnded({}), undefined);
    assert.deepEqual(turnUsageFromTurnEnded({ inputTokens: 5n, outputTokens: 6n, cacheReadTokens: 7n, cacheWriteTokens: 8n }), {
      inputTokens: 5,
      outputTokens: 6,
      cacheReadTokens: 7,
      cacheWriteTokens: 8,
    });
    assert.deepEqual(turnUsageFromTurnEnded({ reasoningTokens: 9n }), {
      inputTokens: 0,
      outputTokens: 0,
      cacheReadTokens: 0,
      cacheWriteTokens: 0,
      reasoningTokens: 9,
    });
    // Reasoning is only a key when the event carried it.
    assert.equal("reasoningTokens" in (turnUsageFromTurnEnded({ inputTokens: 1n }) ?? {}), false);
    assert.deepEqual(turnUsageFromTurnEnded({ inputTokens: max + 1n, outputTokens: -1n }), {
      inputTokens: Number.MAX_SAFE_INTEGER,
      outputTokens: 0,
      cacheReadTokens: 0,
      cacheWriteTokens: 0,
    });
  });

  it("add up without leaving the safe range, and the input total is the input count", () => {
    assert.equal(addTokenCounts(1, 2), 3);
    assert.equal(addTokenCounts(-5, 2), -3);
    assert.equal(addTokenCounts(Number.MAX_SAFE_INTEGER, 1), Number.MAX_SAFE_INTEGER);
    assert.equal(addTokenCounts(Number.MAX_SAFE_INTEGER, Number.MAX_SAFE_INTEGER), Number.MAX_SAFE_INTEGER);
    assert.equal(totalInputTokens({ inputTokens: 7, outputTokens: 1, cacheReadTokens: 2, cacheWriteTokens: 3 }), 7);
  });

  it("merge two usages count by count, or answer the one that exists", () => {
    const first = { inputTokens: 1, outputTokens: 2, cacheReadTokens: 3, cacheWriteTokens: 4 };
    const second = { inputTokens: 10, outputTokens: 20, cacheReadTokens: 30, cacheWriteTokens: 40 };
    assert.deepEqual(mergeTurnUsage(first, second), { inputTokens: 11, outputTokens: 22, cacheReadTokens: 33, cacheWriteTokens: 44 });
    assert.equal(mergeTurnUsage(undefined, second), second);
    assert.equal(mergeTurnUsage(first, undefined), first);
    assert.equal(mergeTurnUsage(undefined, undefined), undefined);
    // The sum is clamped, and reasoning appears only when one side brought it.
    assert.equal(mergeTurnUsage({ ...first, inputTokens: Number.MAX_SAFE_INTEGER }, first)?.inputTokens, Number.MAX_SAFE_INTEGER);
    assert.equal("reasoningTokens" in (mergeTurnUsage(first, second) ?? {}), false);
    assert.deepEqual(mergeTurnUsage({ ...first, reasoningTokens: 5 }, { ...second, reasoningTokens: 7 }), { inputTokens: 11, outputTokens: 22, cacheReadTokens: 33, cacheWriteTokens: 44, reasoningTokens: 12 });
    assert.deepEqual(mergeTurnUsage({ ...first, reasoningTokens: 5 }, second), { inputTokens: 11, outputTokens: 22, cacheReadTokens: 33, cacheWriteTokens: 44, reasoningTokens: 5 }, "an absent reasoning count is zero in the sum");
  });
});