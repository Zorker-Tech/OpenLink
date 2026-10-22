import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import * as mod from '../../source/shared/update.ts';
import { isSlateUpdateTrack, SLATE_UPDATE_TRACKS } from '../../source/shared/update.ts';
describe('the update tracks', () => {
  it('are stable, nightly and dogfood, and only those are recognized', () => {
    assert.deepEqual([...SLATE_UPDATE_TRACKS], ['stable', 'nightly', 'dogfood']);
    assert.deepEqual(Object.keys(mod).sort(), ['SLATE_UPDATE_TRACKS', 'isSlateUpdateTrack']);
    assert.equal(isSlateUpdateTrack('stable'), true);
    assert.equal(isSlateUpdateTrack('nightly'), true);
    assert.equal(isSlateUpdateTrack('dogfood'), true);
    assert.equal(isSlateUpdateTrack('STABLE'), false);
    assert.equal(isSlateUpdateTrack('beta'), false);
    assert.equal(isSlateUpdateTrack(' stable'), false);
    assert.equal(isSlateUpdateTrack(''), false);
    assert.equal(isSlateUpdateTrack(null), false);
    assert.equal(isSlateUpdateTrack(undefined), false);
    assert.equal(isSlateUpdateTrack(42), false);
    assert.equal(isSlateUpdateTrack({}), false);
  });
});
