import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import * as mod from '../../source/host/runner/agent-state.ts';
describe('the result of writing an agent state', () => {
  it('is a success with its detail, or a failure with its reason', () => {
    assert.deepEqual(Object.keys(mod).sort(), ['stateWriteFailed', 'stateWriteOk']);
    assert.deepEqual(mod.stateWriteOk({ saved: 3 }), { ok: true, detail: { saved: 3 } });
    assert.deepEqual(Object.keys(mod.stateWriteOk('x')), ['ok', 'detail']);
    assert.equal(mod.stateWriteOk.length, 1);
    assert.deepEqual(mod.stateWriteFailed('nope'), { ok: false, reason: 'nope' });
    assert.deepEqual(Object.keys(mod.stateWriteFailed('nope')), ['ok', 'reason']);
    assert.equal(mod.stateWriteFailed.length, 1);
    assert.deepEqual(mod.stateWriteOk(undefined), { ok: true, detail: undefined });
  });
});
