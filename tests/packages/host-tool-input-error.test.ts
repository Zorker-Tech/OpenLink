import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import * as mod from '../../source/host/runner/tools/tool-input-error.ts';
describe('the tool input error', () => {
  it('names itself so a tool call can be told from other failures', () => {
    assert.deepEqual(Object.keys(mod), ['SlateToolInputError']);
    const error = new mod.SlateToolInputError('bad input');
    assert.equal(error instanceof mod.SlateToolInputError, true);
    assert.equal(error instanceof Error, true);
    assert.equal(Object.getPrototypeOf(mod.SlateToolInputError.prototype), Error.prototype);
    assert.equal(error.name, 'SlateToolInputError');
    assert.equal(error.message, 'bad input');
    assert.deepEqual(Object.keys(error), ['name']);
    const descriptor = Object.getOwnPropertyDescriptor(error, 'name');
    assert.deepEqual({ writable: descriptor?.writable, enumerable: descriptor?.enumerable, configurable: descriptor?.configurable, value: descriptor?.value }, { writable: true, enumerable: true, configurable: true, value: 'SlateToolInputError' });
    assert.equal(new mod.SlateToolInputError().message, '');
  });
});
