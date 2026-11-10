import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import * as mod from '../../source/shared/slate-text.ts';
describe('text a surface can show', () => {
  it('clamps a line to one trimmed line, and a block with its own line breaks', () => {
    assert.deepEqual(Object.keys(mod).sort(), ['clampBlock', 'clampLine', 'decapitalize', 'slugifyName']);
    assert.equal(mod.clampLine('  a \n\t b  ', 100), 'a b');
    assert.equal(mod.clampLine('a b', 2), 'a ');
    assert.equal(mod.clampLine('a b', 0), '');
    assert.equal(mod.clampBlock('  a\n b  ', 100), 'a\n b');
    assert.equal(mod.clampBlock('a\nb', 2), 'a\n');
  });
  it('decapitalizes the first character only', () => {
    assert.equal(mod.decapitalize(''), '');
    assert.equal(mod.decapitalize('A'), 'a');
    assert.equal(mod.decapitalize('ABC'), 'aBC');
    assert.equal(mod.decapitalize('代理'), '代理');
  });
  it('turns a name into a slug, and builds the fallback from the time when it cannot', () => {
    assert.equal(mod.slugifyName('Hello World', 'pre', 42), 'hello-world');
    assert.equal(mod.slugifyName(' --x-- ', 'pre', 42), 'x');
    assert.equal(mod.slugifyName('a1_b.c', 'pre', 42), 'a1-b-c');
    assert.equal(mod.slugifyName('A'.repeat(60), 'pre', 42), 'a'.repeat(48));
    assert.equal(mod.slugifyName('', 'pre', 42), 'pre-42');
    assert.equal(mod.slugifyName('   ', 'pre', 7), 'pre-7');
    assert.equal(mod.slugifyName('代理', 'pre', 9), 'pre-9');
    assert.equal(mod.slugifyName('a'.repeat(47) + ' B', 'pre', 42), ('a'.repeat(47) + '-b').slice(0, 48));
  });
});
