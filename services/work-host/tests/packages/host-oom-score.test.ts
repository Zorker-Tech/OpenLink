import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import * as mod from '../../source/packages/utils/oom-score.ts';
describe('a child process left behind by its parent', () => {
  it('has no OOM score to reset off this platform, and nothing throws either way', () => {
    assert.deepEqual(Object.keys(mod), ['resetChildOomScoreAdj']);
    assert.equal(mod.resetChildOomScoreAdj.length, 1);
    for (const pid of [undefined, 0, -1, 1, 42, 1e9, Number.NaN, Number.POSITIVE_INFINITY, 1.5]) {
      assert.equal(mod.resetChildOomScoreAdj(pid), undefined, String(pid));
    }
  });
});
