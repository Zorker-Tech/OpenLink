import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import * as mod from '../../source/host/runner/clock-skew-guard.ts';
describe('a duration measured across clocks', () => {
  it('is accepted within its ceiling, rounded, and otherwise named as the skew it looks like', () => {
    assert.deepEqual(mod.sanitizeCrossClockDurationMs(1_000, 120_000), { ms: 1_000 });
    assert.deepEqual(mod.sanitizeCrossClockDurationMs(1_000.6, 120_000), { ms: 1_001 });
    assert.deepEqual(mod.sanitizeCrossClockDurationMs(120_000, 120_000), { ms: 120_000 });
    assert.deepEqual(mod.sanitizeCrossClockDurationMs(120_001, 120_000), { skewReason: 'too_large' });
    assert.deepEqual(mod.sanitizeCrossClockDurationMs(-1, 120_000), { skewReason: 'negative' });
    assert.deepEqual(mod.sanitizeCrossClockDurationMs(Number.NaN, 120_000), { skewReason: 'too_large' });
    assert.deepEqual(mod.sanitizeCrossClockDurationMs(Number.POSITIVE_INFINITY, 120_000), { skewReason: 'too_large' });
    assert.equal(mod.SEND_DISPATCH_MAX_PLAUSIBLE_MS, 120_000);
    assert.equal(mod.TTFT_MAX_PLAUSIBLE_MS, 1_800_000);
  });
  it('buckets a skew by its sign and magnitude', () => {
    assert.equal(mod.bucketClockSkewDeltaMs(Number.NaN), 'nonfinite');
    assert.equal(mod.bucketClockSkewDeltaMs(Number.POSITIVE_INFINITY), 'nonfinite');
    assert.equal(mod.bucketClockSkewDeltaMs(60_000), 'le_1m');
    assert.equal(mod.bucketClockSkewDeltaMs(60_001), 'le_5m');
    assert.equal(mod.bucketClockSkewDeltaMs(300_000), 'le_5m');
    assert.equal(mod.bucketClockSkewDeltaMs(300_001), 'le_15m');
    assert.equal(mod.bucketClockSkewDeltaMs(900_000), 'le_15m');
    assert.equal(mod.bucketClockSkewDeltaMs(900_001), 'gt_15m');
    assert.equal(mod.bucketClockSkewDeltaMs(-1_000), 'neg_le_1s');
    assert.equal(mod.bucketClockSkewDeltaMs(-1_001), 'neg_le_1m');
    assert.equal(mod.bucketClockSkewDeltaMs(-60_000), 'neg_le_1m');
    assert.equal(mod.bucketClockSkewDeltaMs(-60_001), 'neg_gt_1m');
  });
});
