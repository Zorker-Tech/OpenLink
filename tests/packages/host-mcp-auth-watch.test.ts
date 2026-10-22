import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import * as mod from '../../source/shared/node/mcp/mcp-auth-watch.ts';
describe('a watch for a server being authenticated', () => {
  it('has bounded polls and a bounded life, and is keyed by server and account', () => {
    assert.deepEqual(Object.keys(mod).sort(), ['AUTH_WATCH_POLL_INTERVAL_MS', 'AUTH_WATCH_POLL_TIMEOUT_MS', 'AUTH_WATCH_TIMEOUT_MS', 'authWatchKey']);
    assert.equal(mod.AUTH_WATCH_POLL_INTERVAL_MS, 5_000);
    assert.equal(mod.AUTH_WATCH_TIMEOUT_MS, 900_000);
    assert.equal(mod.AUTH_WATCH_POLL_TIMEOUT_MS, 30_000);
    assert.equal(mod.authWatchKey('s1', 'a1'), 's1::a1');
    assert.equal(mod.authWatchKey('', ''), '::');
    assert.equal(mod.authWatchKey('代理', '账户'), '代理::账户');
    assert.equal(mod.authWatchKey('a::b', 'c'), 'a::b::c');
  });
});
