import assert from "node:assert/strict";
import { describe, it } from "node:test";

import {
  BackgroundSummarizationMode,
  DISABLED_BACKGROUND_SUMMARIZATION_PROPS,
  getBackgroundSummarizationTriggerThreshold,
  shouldPersistBackgroundSummarization,
  shouldStartBackgroundSummarization,
  type BackgroundSummarizationProps,
} from "../../source/packages/agent-summarization/background-summarization.ts";

/** The moment compaction starts, in used tokens, for a window of this size. */
const startsAt = (maxTokens: number, props: BackgroundSummarizationProps) => getBackgroundSummarizationTriggerThreshold(maxTokens, props);

/** Whether a finished summary would be kept at this point in the window. */
const kept = (usedTokens: number, maxTokens: number, props: BackgroundSummarizationProps) => shouldPersistBackgroundSummarization(usedTokens, maxTokens, props);

describe("when a compaction should start", () => {
  it("takes the earlier of the two thresholds a session may set", () => {
    const both: BackgroundSummarizationProps = { unusedTokensThresholdToStartBackgroundSummarization: 20_000, unusedPercentTokensThresholdToStartBackgroundSummarization: 0.05 };
    // 20k of room left is 80k used; a twentieth of the window left is 95k used, which comes later, so 80k wins.
    assert.equal(startsAt(100_000, both), 80_000);
    // And the other way round: a tenth of the window left is 90k used, earlier than 20k of room (80k used).
    const fractionFirst: BackgroundSummarizationProps = { unusedTokensThresholdToStartBackgroundSummarization: 20_000, unusedPercentTokensThresholdToStartBackgroundSummarization: 0.1 };
    assert.equal(startsAt(100_000, fractionFirst), 80_000);
    const absoluteLate: BackgroundSummarizationProps = { unusedTokensThresholdToStartBackgroundSummarization: 2_000, unusedPercentTokensThresholdToStartBackgroundSummarization: 0.25 };
    assert.equal(startsAt(100_000, absoluteLate), 75_000, "a quarter of the window left is 75k used, earlier than 2k of room");
    assert.equal(startsAt(100_000, { unusedTokensThresholdToStartBackgroundSummarization: 10_000 }), 90_000);
    assert.equal(startsAt(100_000, { unusedPercentTokensThresholdToStartBackgroundSummarization: 0.25 }), 75_000);
  });

  it("has no moment at all for a session that asked for none, or a window with no room", () => {
    assert.equal(startsAt(100_000, {}), undefined);
    assert.equal(startsAt(100_000, DISABLED_BACKGROUND_SUMMARIZATION_PROPS), undefined);
    assert.equal(startsAt(0, { unusedTokensThresholdToStartBackgroundSummarization: 1 }), undefined);
    assert.equal(startsAt(-5, { unusedPercentTokensThresholdToStartBackgroundSummarization: 0.5 }), undefined);
  });

  it("counts a threshold of nothing as a moment at the very start", () => {
    assert.equal(startsAt(100_000, { unusedTokensThresholdToStartBackgroundSummarization: 0 }), 100_000);
    assert.equal(startsAt(100_000, { unusedPercentTokensThresholdToStartBackgroundSummarization: 0 }), 100_000);
    assert.equal(startsAt(100_000, { unusedPercentTokensThresholdToStartBackgroundSummarization: 1 }), 0);
  });

  it("starts at the moment and not a token before it", () => {
    const props: BackgroundSummarizationProps = { unusedTokensThresholdToStartBackgroundSummarization: 10_000 };
    assert.equal(shouldStartBackgroundSummarization(90_000, 100_000, props), true);
    assert.equal(shouldStartBackgroundSummarization(89_999, 100_000, props), false);
  });

  it("never starts one in a session with no thresholds, however full the window is", () => {
    assert.equal(shouldStartBackgroundSummarization(100_000, 100_000, DISABLED_BACKGROUND_SUMMARIZATION_PROPS), false);
    assert.equal(shouldStartBackgroundSummarization(100_000, 100_000, {}), false);
  });
});

describe("whether a finished summary is kept", () => {
  it("keeps nothing from a compaction that never started", () => {
    const props: BackgroundSummarizationProps = { unusedTokensThresholdToStartBackgroundSummarization: 10_000, unusedTokensThresholdToPersistBackgroundSummarization: 2_000 };
    assert.equal(kept(50_000, 100_000, props), false);
  });

  it("keeps one written with very little room left, and drops one written with room to spare", () => {
    const props: BackgroundSummarizationProps = { unusedTokensThresholdToStartBackgroundSummarization: 10_000, unusedTokensThresholdToPersistBackgroundSummarization: 2_000 };
    assert.equal(kept(99_000, 100_000, props), true);
    assert.equal(kept(95_000, 100_000, props), false, "room left means the conversation has moved on since");
  });

  it("decides the same question by a fraction of the window", () => {
    const props: BackgroundSummarizationProps = { unusedPercentTokensThresholdToStartBackgroundSummarization: 0.1, unusedPercentTokensThresholdToPersistBackgroundSummarization: 0.02 };
    assert.equal(kept(99_000, 100_000, props), true);
    assert.equal(kept(95_000, 100_000, props), false);
  });

  it("keeps one when either way of measuring the room left says it is time", () => {
    const byAbsolute: BackgroundSummarizationProps = { unusedTokensThresholdToStartBackgroundSummarization: 10_000, unusedTokensThresholdToPersistBackgroundSummarization: 2_000 };
    assert.equal(kept(99_000, 100_000, byAbsolute), true);
    // A fraction that would not keep it cannot undo an absolute allowance that would.
    const both: BackgroundSummarizationProps = { ...byAbsolute, unusedPercentTokensThresholdToPersistBackgroundSummarization: 0 };
    assert.equal(kept(99_000, 100_000, both), true);
  });

  it("keeps nothing when the room is small but compaction had not started yet", () => {
    // The allowance to keep is met at 99k, but nothing starts before the window is completely full.
    const lateStart: BackgroundSummarizationProps = { unusedTokensThresholdToStartBackgroundSummarization: 0, unusedTokensThresholdToPersistBackgroundSummarization: 2_000 };
    assert.equal(kept(99_000, 100_000, lateStart), false, "a summary written before the start is not one to keep");
    assert.equal(kept(100_000, 100_000, lateStart), true);
  });

  it("keeps nothing when no way of measuring the room was set, however full the window", () => {
    const started: BackgroundSummarizationProps = { unusedTokensThresholdToStartBackgroundSummarization: 10_000 };
    assert.equal(kept(100_000, 100_000, started), false);
  });
});

describe("the modes a session can ask for", () => {
  it("are named for what they do, in the order they are declared", () => {
    assert.deepEqual(Object.values(BackgroundSummarizationMode), [
      "Background",
      "BackgroundAndPersistIfCompleted",
      "WaitForCompletion",
      "WaitForCompletionIfStarted",
    ]);
    assert.deepEqual(Object.keys(BackgroundSummarizationMode), ["Background", "BackgroundAndPersistIfCompleted", "WaitForCompletion", "WaitForCompletionIfStarted"]);
  });

  it("tell a session with compaction switched off apart from one that set nothing", () => {
    assert.deepEqual(DISABLED_BACKGROUND_SUMMARIZATION_PROPS, {
      unusedTokensThresholdToStartBackgroundSummarization: undefined,
      unusedPercentTokensThresholdToStartBackgroundSummarization: undefined,
      unusedTokensThresholdToPersistBackgroundSummarization: undefined,
      unusedPercentTokensThresholdToPersistBackgroundSummarization: undefined,
    });
  });
});
