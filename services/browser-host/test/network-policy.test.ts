import test from 'node:test'
import assert from 'node:assert/strict'
import { BrowserNetworkGuard } from '../src/network-policy.js'

test('network guard denies loopback unless explicitly enabled', async () => {
  const denied = new BrowserNetworkGuard({ allowedDomains: [], deniedDomains: [], allowLoopback: false, allowPrivateNetworks: false })
  await assert.rejects(() => denied.assertUrl('http://127.0.0.1:3000'), /Loopback access is denied/)
  const allowed = new BrowserNetworkGuard({ allowedDomains: ['127.0.0.1'], deniedDomains: [], allowLoopback: true, allowPrivateNetworks: false })
  assert.equal((await allowed.assertUrl('http://127.0.0.1:3000')).hostname, '127.0.0.1')
})

test('network guard enforces domain patterns before DNS access', async () => {
  const guard = new BrowserNetworkGuard({ allowedDomains: ['*.example.com'], deniedDomains: ['blocked.example.com'], allowLoopback: false, allowPrivateNetworks: false })
  await assert.rejects(() => guard.assertUrl('https://blocked.example.com'), /denied/)
  await assert.rejects(() => guard.assertUrl('https://example.net'), /not allowlisted/)
})
