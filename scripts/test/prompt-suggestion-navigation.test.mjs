import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import test from 'node:test'

import { enabledSuggestionIndex, nextEnabledSuggestionIndex } from '../../lib/prompt-suggestion-navigation.ts'

const items = [{ disabled: true }, {}, { disabled: true }, {}]

test('active suggestion falls forward to the first enabled option', () => {
  assert.equal(enabledSuggestionIndex(items, 0), 1)
  assert.equal(enabledSuggestionIndex(items, 3), 3)
  assert.equal(enabledSuggestionIndex([{ disabled: true }], 0), -1)
})

test('arrow navigation wraps while skipping disabled options', () => {
  assert.equal(nextEnabledSuggestionIndex(items, 1, 1), 3)
  assert.equal(nextEnabledSuggestionIndex(items, 3, 1), 1)
  assert.equal(nextEnabledSuggestionIndex(items, 1, -1), 3)
  assert.equal(nextEnabledSuggestionIndex([{ disabled: true }], -1, 1), -1)
})

test('an all-disabled picker consumes Enter but lets Tab move focus away', () => {
  const source = readFileSync(new URL('../../components/agent-prompt-textarea.tsx', import.meta.url), 'utf8')
  const tabBranch = source.match(/else if \(event\.key === 'Tab'\) \{([\s\S]*?)\n\s*\} else if \(event\.key === 'Enter'/)?.[1] ?? ''
  const enterBranch = source.match(/else if \(event\.key === 'Enter' && !event\.shiftKey\) \{([\s\S]*?)\n\s*\} else if \(event\.key === 'Escape'/)?.[1] ?? ''

  assert.match(tabBranch, /if \(activeSuggestion\)/)
  assert.match(tabBranch, /setTrigger\(null\)/)
  assert.doesNotMatch(tabBranch.split('else {').at(-1) ?? '', /event\.preventDefault\(\)/)
  assert.match(enterBranch, /event\.preventDefault\(\)/)
  assert.match(enterBranch, /if \(activeSuggestion\) choose\(activeSuggestion\)/)
})
