import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import * as mod from '../../source/shared/message-reference.ts';
describe('a message address', () => {
  it('is the platform grammar, and only a value that matches it names a message', () => {
    assert.equal(mod.MESSAGE_ADDRESS_EXACT.source, '^t(?:\\d+u(?:a\\d+)?|(?:\\d+|b)[as]\\d+)$');
    assert.equal(mod.MESSAGE_ADDRESS_EXACT.flags, '');
    assert.deepEqual(Object.keys(mod).sort(), ['MESSAGE_ADDRESS_EXACT', 'isMessageAddress']);
    for (const value of ['t1s2', 't1a2', 'tbs3', 't1u', 't1ua2', 't2u', 't999u', 't1s2']) assert.equal(mod.isMessageAddress(value), true, value);
    for (const value of ['t1s', 't', 't1', 'x1s2', 'T1S2', ' t1s2', 't1s2 ', 'tbs', 't1.5s2', 't0s0x', 'tt1s2', 't1as2', '']) assert.equal(mod.isMessageAddress(value), false, JSON.stringify(value));
    assert.equal(mod.isMessageAddress('t01u'), true);
  });
});