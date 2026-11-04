import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import * as diff from '../../source/packages/constants/git-diff.ts';
describe('the diff constants', () => {
  it('names the budget, the prompt words and the truncation notice', () => {
    assert.equal(diff.GIT_DIFF_APPROXIMATE_MAX_TOKENS, 10_000);
    assert.equal(diff.GIT_DIFF_CHARS_PER_TOKEN, 4);
    assert.equal(diff.MAX_GIT_DIFF_CHAR_LENGTH, 40_000);
    assert.equal(diff.MAX_GIT_DIFF_CHAR_LENGTH, diff.GIT_DIFF_APPROXIMATE_MAX_TOKENS * diff.GIT_DIFF_CHARS_PER_TOKEN);
    assert.equal(diff.GIT_DIFF_INTRO, 'Changes between this branch and the default branch:\n\n');
    assert.equal(diff.GIT_DIFF_UNCOMMITTED_INTRO, 'Workspace changes not yet committed:\n\n');
    assert.equal(diff.GIT_DIFF_TRUNCATION_NOTICE, '\n\n[diff truncated to fit the context; inspect the repository diff for the complete change]');
    assert.deepEqual(Object.keys(diff).sort(), ['GIT_DIFF_APPROXIMATE_MAX_TOKENS', 'GIT_DIFF_CHARS_PER_TOKEN', 'GIT_DIFF_INTRO', 'GIT_DIFF_TRUNCATION_NOTICE', 'GIT_DIFF_UNCOMMITTED_INTRO', 'MAX_GIT_DIFF_CHAR_LENGTH']);
  });
});
