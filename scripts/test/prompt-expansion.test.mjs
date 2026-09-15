import assert from 'node:assert/strict'
import test from 'node:test'
import { promptShouldExpand } from '../../lib/prompt-expansion.ts'

test('empty and one-line text remain compact', () => {
  assert.equal(promptShouldExpand('', 20, false), false)
  assert.equal(promptShouldExpand('hello', 20, false), false)
})
test('soft wrapping and explicit newlines expand', () => {
  assert.equal(promptShouldExpand('帮我开发一个热点收集的web应用，需要有DeepSeek', 40, false), true)
  assert.equal(promptShouldExpand('第一行\n第二行', 20, false), true)
})
test('wider expanded layout cannot collapse during editing', () => {
  assert.equal(promptShouldExpand('原先换行的文本', 20, true), true)
})
test('clearing collapses even before the textarea has shrunk', () => {
  assert.equal(promptShouldExpand('', 120, true), false)
})
