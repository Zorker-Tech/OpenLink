import assert from 'node:assert/strict'
import test from 'node:test'

import { codexReviewTarget } from '../../services/agent-worker/src/codex-review.ts'

test('plain review uses the native uncommitted-changes target', () => {
  assert.deepEqual(codexReviewTarget('/review'), { type: 'uncommittedChanges' })
  assert.deepEqual(codexReviewTarget('/REVIEW  '), { type: 'uncommittedChanges' })
})

test('inline review instructions use the native custom target', () => {
  assert.deepEqual(codexReviewTarget('/review focus on auth boundaries'), {
    type: 'custom',
    instructions: 'focus on auth boundaries',
  })
})

test('ordinary prompts and lookalike commands are not reviews', () => {
  assert.equal(codexReviewTarget('please /review this'), null)
  assert.equal(codexReviewTarget('/reviewer'), null)
})
