import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import * as mod from '../../source/host/local-exec/local-exec-error.ts';
describe('the local executor error', () => {
  it('is a plain Error subclass with no behaviour of its own', () => {
    assert.deepEqual(Object.keys(mod), ['SlateLocalExecError']);
    const error = new mod.SlateLocalExecError('could not start');
    assert.equal(error instanceof mod.SlateLocalExecError, true);
    assert.equal(error instanceof Error, true);
    assert.equal(Object.getPrototypeOf(mod.SlateLocalExecError.prototype), Error.prototype);
    assert.equal(error.constructor.name, 'SlateLocalExecError');
    assert.equal(error.message, 'could not start');
    assert.equal(error.name, 'Error', 'the name is the one Error gives it');
    assert.deepEqual(Object.keys(error), [], 'an instance carries no own enumerable fields');
    assert.equal(new mod.SlateLocalExecError().message, '');
  });
});
