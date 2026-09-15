import test from 'node:test'
import assert from 'node:assert/strict'

import { transitionAccessMode } from '../../lib/access-mode-transition.ts'
import { readFileSync } from 'node:fs'

const workspace = readFileSync(new URL('../../components/chat-workspace.tsx', import.meta.url), 'utf8')

test('the permission picker updates optimistically before runtime replacement', () => {
  const change = workspace.slice(workspace.indexOf('const changeAccessMode = useCallback'), workspace.indexOf('useEffect(() => {', workspace.indexOf('const changeAccessMode = useCallback')))
  assert.ok(change.indexOf('setAccessMode(mode)') < change.indexOf('await transitionAccessMode('))
  assert.match(change, /setAccessMode\(previousMode\)/)
})

test('access mode becomes visible only after runtime policy verification', async () => {
  const calls = []
  const resources = { accessMode: 'open', mcpServers: [] }
  const result = await transitionAccessMode({
    currentMode: 'restricted', nextMode: 'open',
    persistMode: async (mode) => { calls.push(`persist:${mode}`); return true },
    leaseRuntime: async () => { calls.push('lease'); return true },
    readRuntimeResources: async () => { calls.push('verify'); return resources },
  })
  assert.deepEqual(calls, ['persist:open', 'lease', 'verify'])
  assert.deepEqual(result, { ok: true, mode: 'open', resources, unchanged: false })
})

test('failed runtime lease restores the persisted and leased previous policy', async () => {
  const calls = []
  let leaseCount = 0
  const result = await transitionAccessMode({
    currentMode: 'ask', nextMode: 'open',
    persistMode: async (mode) => { calls.push(`persist:${mode}`); return true },
    leaseRuntime: async () => { calls.push('lease'); leaseCount += 1; return leaseCount > 1 },
    readRuntimeResources: async () => { calls.push('verify'); return null },
  })
  assert.deepEqual(calls, ['persist:open', 'lease', 'persist:ask', 'lease'])
  assert.deepEqual(result, { ok: false, mode: 'ask', failure: 'lease', rollbackSucceeded: true })
})

test('mismatched runtime policy is rejected and rolled back', async () => {
  const calls = []
  const result = await transitionAccessMode({
    currentMode: 'restricted', nextMode: 'open',
    persistMode: async (mode) => { calls.push(`persist:${mode}`); return true },
    leaseRuntime: async () => { calls.push('lease'); return true },
    readRuntimeResources: async () => { calls.push('verify'); return { accessMode: 'restricted' } },
  })
  assert.deepEqual(calls, ['persist:open', 'lease', 'verify', 'persist:restricted', 'lease'])
  assert.deepEqual(result, { ok: false, mode: 'restricted', failure: 'verify', rollbackSucceeded: true })
})

test('failed persistence never replaces the running worker', async () => {
  const calls = []
  const result = await transitionAccessMode({
    currentMode: 'restricted', nextMode: 'ask',
    persistMode: async (mode) => { calls.push(`persist:${mode}`); return false },
    leaseRuntime: async () => { calls.push('lease'); return true },
    readRuntimeResources: async () => null,
  })
  assert.deepEqual(calls, ['persist:ask'])
  assert.deepEqual(result, { ok: false, mode: 'restricted', failure: 'persist', rollbackSucceeded: true })
})
