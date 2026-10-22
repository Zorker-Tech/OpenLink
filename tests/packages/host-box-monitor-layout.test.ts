import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import * as mod from '../../source/host/boxes/box-monitor-layout.ts';
describe('the coordinate space of a box screen', () => {
  it('describes the fixed size and the bounds a coordinate may fall in', () => {
    assert.equal(mod.SLATE_MONITOR_WIDTH, 1280);
    assert.equal(mod.SLATE_MONITOR_HEIGHT, 800);
    assert.equal(mod.displaySpaceSentence(), 'Display is 1280×800. Computer click/move/scroll x,y are pixels in that space (origin top-left); never emit coordinates outside 0..1279 × 0..799.');
    assert.equal(mod.displaySpaceSentence({ width: 100, height: 50 }), 'Display is 100×50. Computer click/move/scroll x,y are pixels in that space (origin top-left); never emit coordinates outside 0..99 × 0..49.');
    assert.equal(mod.displaySpaceSentence({ width: 1 }), 'Display is 1×800. Computer click/move/scroll x,y are pixels in that space (origin top-left); never emit coordinates outside 0..0 × 0..799.');
    assert.equal(mod.displaySpaceSentence({ height: 1 }), 'Display is 1280×1. Computer click/move/scroll x,y are pixels in that space (origin top-left); never emit coordinates outside 0..1279 × 0..0.');
  });
});
