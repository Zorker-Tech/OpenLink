import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import * as paths from '../../source/packages/utils/conversation-paths.ts';
import { getSafeConversationId, MAX_CONVERSATION_ID_LENGTH, TRANSCRIPTS_SUBDIR } from '../../source/packages/utils/conversation-paths.ts';
describe('a conversation id as a path component', () => {
  it('names the transcripts directory and the bound, and exports the one reader', () => {
    assert.equal(TRANSCRIPTS_SUBDIR, 'agent-transcripts');
    assert.equal(MAX_CONVERSATION_ID_LENGTH, 200);
    assert.deepEqual(Object.keys(paths).sort(), ['MAX_CONVERSATION_ID_LENGTH', 'TRANSCRIPTS_SUBDIR', 'getSafeConversationId']);
  });
  it('encodes the id and turns every percent marker into an underscore', () => {
    assert.equal(getSafeConversationId('conv-123'), 'conv-123');
    assert.equal(getSafeConversationId('a/b'), 'a_2Fb');
    assert.equal(getSafeConversationId('a%2Fb'), 'a_252Fb', 'the existing escape is escaped too');
    assert.equal(getSafeConversationId('%'), '_25');
    assert.equal(getSafeConversationId('a b'), 'a_20b');
    assert.equal(getSafeConversationId('代理'), '_E4_BB_A3_E7_90_86');
  });
  it('bounds an over-long component, and leaves one at the bound alone', () => {
    assert.equal(getSafeConversationId('x'.repeat(199)).length, 199);
    assert.equal(getSafeConversationId('x'.repeat(200)).length, 200);
    assert.equal(getSafeConversationId('x'.repeat(201)).length, 200);
    assert.equal(getSafeConversationId('/'.repeat(150)), '_2F'.repeat(66) + '_2', 'the encoding can make a short id long, and the bound applies after it');
  });
});