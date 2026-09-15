import test from 'node:test'
import assert from 'node:assert/strict'
import { BrowserNetworkGuard } from '../src/network-policy.js'

test('network guard denies loopback unless explicitly enabled', async () => {
  const denied = new BrowserNetworkGuard({ allowedDomains: [], deniedDomains: [], allowLoopback: false, allowPrivateNetworks: false })
  await assert.rejects(() => denied.assertUrl('http://127.0.0.1:3000'), /Loopback access is denied/)
  await assert.rejects(() => denied.assertUrl('http://[::ffff:127.0.0.1]:3000'), /Loopback access is denied/)
  await assert.rejects(() => denied.assertUrl('http://[0:0:0:0:0:ffff:192.168.1.10]:3000'), /Private network access is denied/)
  const allowed = new BrowserNetworkGuard({ allowedDomains: ['127.0.0.1'], deniedDomains: [], allowLoopback: true, allowPrivateNetworks: false })
  assert.equal((await allowed.assertUrl('http://127.0.0.1:3000')).hostname, '127.0.0.1')
})

test('network guard enforces domain patterns before DNS access', async () => {
  const guard = new BrowserNetworkGuard({ allowedDomains: ['*.example.com'], deniedDomains: ['blocked.example.com'], allowLoopback: false, allowPrivateNetworks: false })
  await assert.rejects(() => guard.assertUrl('https://blocked.example.com'), /denied/)
  await assert.rejects(() => guard.assertUrl('https://example.net'), /not allowlisted/)
})

test('network guard accepts fake-IP DNS for a domain but rejects the same literal address', async () => {
  const guard = new BrowserNetworkGuard(
    { allowedDomains: [], deniedDomains: [], allowLoopback: false, allowPrivateNetworks: false },
    Date.now,
    async () => [{ address: '198.18.1.81', family: 4 }],
  )
  assert.equal((await guard.assertUrl('https://example.com')).hostname, 'example.com')
  await assert.rejects(() => guard.assertUrl('https://198.18.1.81'), /Private network access is denied/)
})

test('network guard still rejects RFC1918 DNS answers', async () => {
  const guard = new BrowserNetworkGuard(
    { allowedDomains: [], deniedDomains: [], allowLoopback: false, allowPrivateNetworks: false },
    Date.now,
    async () => [{ address: '192.168.1.25', family: 4 }],
  )
  await assert.rejects(() => guard.assertUrl('https://internal.example'), /Private network access is denied/)
})
