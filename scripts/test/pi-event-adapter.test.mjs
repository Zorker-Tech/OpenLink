import assert from 'node:assert/strict'
import test from 'node:test'

import { PiEventAdapter } from '../../lib/agent-runtime/pi-event-adapter.ts'

const adapter = () => new PiEventAdapter('PISESSION1', () => '2026-01-01T00:00:00Z', 100)

test('Pi text_end and message_end produce one authoritative assistant completion', () => {
  const value = adapter()
  const events = [
    ...value.adapt({ type: 'message_start', message: { role: 'assistant', content: [] } }),
    ...value.adapt({ type: 'message_update', assistantMessageEvent: { type: 'text_start' } }),
    ...value.adapt({ type: 'message_update', assistantMessageEvent: { type: 'text_delta', delta: 'hello' } }),
    ...value.adapt({ type: 'message_update', assistantMessageEvent: { type: 'text_end', content: 'hello' } }),
    ...value.adapt({ type: 'message_end', message: { role: 'assistant', content: [{ type: 'text', text: 'hello' }], stopReason: 'stop' } }),
  ]

  assert.deepEqual(events.map((event) => event.type), ['message.delta', 'message.completed'])
  assert.equal(events[1].text, 'hello')
})

test('Pi message_end remains the error authority after text_end', () => {
  const value = adapter()
  const events = [
    ...value.adapt({ type: 'message_start', message: { role: 'assistant', content: [] } }),
    ...value.adapt({ type: 'message_update', assistantMessageEvent: { type: 'text_end', content: 'partial' } }),
    ...value.adapt({ type: 'message_end', message: { role: 'assistant', content: [{ type: 'text', text: 'partial' }], stopReason: 'error', errorMessage: 'provider failed' } }),
  ]

  assert.deepEqual(events.map((event) => event.type), ['error'])
  assert.equal(events[0].message, 'provider failed')
})
