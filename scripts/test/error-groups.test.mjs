import test from 'node:test'
import assert from 'node:assert/strict'
import { agentErrorTitle, groupAgentErrorRecords } from '../../lib/agent-runtime/error-groups.ts'

test('normalizes reconnect attempts into one diagnostic title', () => {
  assert.equal(agentErrorTitle('Reconnecting... 1/5'), 'Reconnecting…')
  assert.equal(agentErrorTitle('Reconnecting... 5/5'), 'Reconnecting…')
})

test('groups repeated error titles without discarding individual details', () => {
  const groups = groupAgentErrorRecords([
    { id: 'one', message: 'Reconnecting... 1/5' },
    { id: 'two', message: '401 invalid API key from provider A' },
    { id: 'three', message: 'Reconnecting... 2/5' },
    { id: 'four', message: 'Unauthorized from provider B' },
  ])
  assert.deepEqual(groups.map(({ id, title, messages }) => ({ id, title, messages })), [
    { id: 'one', title: 'Reconnecting…', messages: ['Reconnecting... 1/5', 'Reconnecting... 2/5'] },
    { id: 'two', title: 'Agent 鉴权失败', messages: ['401 invalid API key from provider A', 'Unauthorized from provider B'] },
  ])
})
