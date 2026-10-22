import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import * as mod from '../../source/packages/agent-store-sync/conflict-notice-claim-state.ts';
describe('the announced-event memory', () => {
  it('remembers at most its size, and drops an eighth at a time', () => {
    assert.deepEqual(Object.keys(mod).sort(), ['ANNOUNCED_EVICTION_BATCH', 'MAX_ANNOUNCED_EVENT_IDS']);
    assert.equal(mod.MAX_ANNOUNCED_EVENT_IDS, 65_536);
    assert.equal(mod.ANNOUNCED_EVICTION_BATCH, 8_192);
    assert.equal(mod.ANNOUNCED_EVICTION_BATCH, Math.max(1, Math.floor(mod.MAX_ANNOUNCED_EVENT_IDS / 8)));
  });
});
