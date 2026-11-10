import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import * as mod from '../../source/packages/agent-store-sync/etag.ts';
import { normalizeS3Etag, stripS3EtagQuotes } from '../../source/packages/agent-store-sync/etag.ts';
describe('an object store entity tag', () => {
  it('is stripped of its quotes, trimmed, and empty when missing', () => {
    assert.equal(stripS3EtagQuotes(null), '');
    assert.equal(stripS3EtagQuotes(undefined), '');
    assert.equal(stripS3EtagQuotes(''), '');
    assert.equal(stripS3EtagQuotes('   '), '');
    assert.equal(stripS3EtagQuotes('abc'), 'abc');
    assert.equal(stripS3EtagQuotes('  "abc"  '), 'abc');
    assert.equal(stripS3EtagQuotes('"abc'), '"abc', 'a one-sided quote is not a quoted tag');
    assert.equal(stripS3EtagQuotes('""'), '');
    assert.deepEqual(Object.keys(mod).sort(), ['normalizeS3Etag', 'stripS3EtagQuotes']);
  });
  it('is compared without quotes and without case', () => {
    assert.equal(normalizeS3Etag('"ABC789"'), 'abc789');
    assert.equal(normalizeS3Etag(' AbC789 '), 'abc789');
    assert.equal(normalizeS3Etag(null), '');
    assert.equal(normalizeS3Etag('代理'), '代理');
  });
});
