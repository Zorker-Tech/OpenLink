import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import test from 'node:test'

const timeline = readFileSync(new URL('../../components/chat-timeline.tsx', import.meta.url), 'utf8')

test('a conversational turn does not leave a completed "Thought for a moment" row', () => {
  assert.match(timeline, /nonMessageItems\.filter\(\(item\) => item\.kind !== 'reasoning'\)/)
  assert.match(timeline, /t\('Thought for a moment'\)/)
})

test('successful turns end on their content instead of a completed marker', () => {
  assert.match(timeline, /status === 'idle' \|\| status === 'running' \|\| status === 'settled'\) return null/)
  assert.doesNotMatch(timeline, /status === 'settled'\s*\?\s*\{ icon: CircleCheck/)
  assert.match(timeline, /data-timeline-end=\{status\}/)
})

test('active task titles use the ai-elements Shimmer treatment', () => {
  assert.match(timeline, /import \{ Shimmer \} from '@\/components\/ai-elements\/shimmer'/)
  assert.match(timeline, /active && typeof children === 'string'/)
  assert.match(timeline, /<Shimmer as="span" duration=\{2\.2\} spread=\{2\.4\}>/)
  assert.doesNotMatch(timeline, /timeline-live-sweep/)
})
