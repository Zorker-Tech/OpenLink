import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import * as mod from '../../source/host/ports/product-analytics.ts';
describe('the product analytics port', () => {
  it('has a silent implementation that accepts and drops events', () => {
    assert.deepEqual(Object.keys(mod), ['createNoopSlateProductAnalytics']);
    const port = mod.createNoopSlateProductAnalytics();
    assert.deepEqual(Object.keys(port), ['trackEvent']);
    assert.equal(typeof port.trackEvent, 'function');
    assert.equal(port.trackEvent('a'), undefined);
    assert.equal(port.trackEvent('b', { c: 1 }), undefined);
    assert.notEqual(mod.createNoopSlateProductAnalytics(), port, 'each caller gets its own port');
  });
});
