import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import * as mod from '../../source/host/ports/slate-analytics-types.ts';
import { slateMessageLengthBucket } from '../../source/host/ports/slate-analytics-types.ts';
describe('the message length bucket', () => {
  it('groups a length into the bucket it falls in', () => {
    assert.deepEqual(Object.keys(mod), ['slateMessageLengthBucket']);
    assert.equal(slateMessageLengthBucket(0), 'empty');
    assert.equal(slateMessageLengthBucket(-1), 'empty');
    assert.equal(slateMessageLengthBucket(-Infinity), 'empty');
    assert.equal(slateMessageLengthBucket(0.5), 'xs');
    assert.equal(slateMessageLengthBucket(19), 'xs');
    assert.equal(slateMessageLengthBucket(20), 's');
    assert.equal(slateMessageLengthBucket(99), 's');
    assert.equal(slateMessageLengthBucket(100), 'm');
    assert.equal(slateMessageLengthBucket(499), 'm');
    assert.equal(slateMessageLengthBucket(500), 'l');
    assert.equal(slateMessageLengthBucket(1_999), 'l');
    assert.equal(slateMessageLengthBucket(2_000), 'xl');
    assert.equal(slateMessageLengthBucket(1e9), 'xl');
    assert.equal(slateMessageLengthBucket(Number.NaN), 'xl');
    assert.equal(slateMessageLengthBucket(Number.POSITIVE_INFINITY), 'xl');
  });
});
