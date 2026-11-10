import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import * as mod from '../../source/packages/plugin-install/identifiers.ts';
import { getPluginDbId } from '../../source/packages/plugin-install/identifiers.ts';
describe('a plugin identifier', () => {
  it('answers a database id only for the sources the platform publishes', () => {
    assert.deepEqual(Object.keys(mod), ['getPluginDbId']);
    assert.equal(getPluginDbId({ source: 'first-party', sourceInfo: { pluginDbId: 'db-1' } }), 'db-1');
    assert.equal(getPluginDbId({ source: 'third-party', sourceInfo: { pluginDbId: 'db-2' } }), 'db-2');
    assert.equal(getPluginDbId({ source: 'slate-plugin', sourceInfo: { pluginDbId: 'ignored' } }), undefined);
    assert.equal(getPluginDbId({ source: 'user-local' }), undefined);
    assert.equal(getPluginDbId({ source: 'extension', sourceInfo: 'x' }), undefined);
  });
});
