import assert from 'node:assert/strict';
import path from 'node:path';
import { describe, it } from 'node:test';
import * as mod from '../../source/packages/agent/utils/request-paths.ts';
describe('the path flavour a request uses', () => {
  it('follows the operating system the request names, and defaults to posix', () => {
    assert.deepEqual(Object.keys(mod), ['getRequestPathModule']);
    assert.equal(mod.getRequestPathModule({}), path.posix);
    assert.equal(mod.getRequestPathModule({ env: {} }), path.posix);
    assert.equal(mod.getRequestPathModule({ env: { osVersion: 'linux 6.1' } }), path.posix);
    assert.equal(mod.getRequestPathModule({ env: { osVersion: 'darwin 23' } }), path.posix);
    assert.equal(mod.getRequestPathModule({ env: { osVersion: 'windows win32' } }), path.win32);
    assert.equal(mod.getRequestPathModule({ env: { osVersion: 'Win32' } }), path.win32);
    assert.equal(mod.getRequestPathModule({ env: { osVersion: 'WIN32' } }), path.win32);
    assert.equal(mod.getRequestPathModule({ env: { osVersion: 'win64' } }), path.posix);
    assert.equal(mod.getRequestPathModule({ env: { osVersion: 'linux win32ish' } }), path.win32);
  });
});
