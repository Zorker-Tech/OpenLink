import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import * as mod from '../../source/shared/send-acceptance.ts';
describe('what a send acceptance reports', () => {
  it('names the refusal, the host slot and the switch that turns the check off', () => {
    assert.deepEqual(Object.keys(mod).sort(), ['DISABLE_SEND_ACCEPT_RETURN_ENV', 'HOST_ACCOUNT_SLOT', 'NONCE_DIGEST_MISMATCH']);
    assert.equal(mod.NONCE_DIGEST_MISMATCH, 'send/nonce-digest-mismatch');
    assert.equal(mod.HOST_ACCOUNT_SLOT, 'host');
    assert.equal(mod.DISABLE_SEND_ACCEPT_RETURN_ENV, 'SLATE_DISABLE_SEND_ACCEPT_RETURN');
  });
});
