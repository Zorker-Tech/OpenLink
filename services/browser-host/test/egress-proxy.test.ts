import test from 'node:test'
import assert from 'node:assert/strict'
import { createServer, request as httpRequest } from 'node:http'
import { once } from 'node:events'
import { BrowserEgressProxy } from '../src/egress-proxy.js'
import { BrowserNetworkGuard } from '../src/network-policy.js'

async function requestThroughProxy(proxyUrl: string, targetUrl: string): Promise<{ status: number; body: string }> {
  const proxy = new URL(proxyUrl)
  return new Promise((resolve, reject) => {
    const request = httpRequest({ hostname: proxy.hostname, port: proxy.port, method: 'GET', path: targetUrl, headers: { Host: new URL(targetUrl).host } }, (response) => {
      const chunks: Buffer[] = []
      response.on('data', (chunk) => chunks.push(Buffer.from(chunk)))
      response.on('end', () => resolve({ status: response.statusCode ?? 0, body: Buffer.concat(chunks).toString('utf8') }))
    })
    request.once('error', reject)
    request.end()
  })
}

test('egress proxy connects to a policy-approved resolved address', async (t) => {
  const upstream = createServer((_request, response) => response.end('approved'))
  upstream.listen(0, '127.0.0.1')
  await once(upstream, 'listening')
  t.after(() => upstream.close())
  const address = upstream.address()
  if (!address || typeof address === 'string') throw new Error('No upstream address')
  const proxy = new BrowserEgressProxy(new BrowserNetworkGuard({ allowedDomains: ['127.0.0.1'], deniedDomains: [], allowLoopback: true, allowPrivateNetworks: false }))
  await proxy.start()
  t.after(() => proxy.close())
  const result = await requestThroughProxy(proxy.url, `http://127.0.0.1:${address.port}/health`)
  assert.deepEqual(result, { status: 200, body: 'approved' })
})

test('egress proxy blocks loopback SSRF before opening the upstream socket', async (t) => {
  const proxy = new BrowserEgressProxy(new BrowserNetworkGuard({ allowedDomains: [], deniedDomains: [], allowLoopback: false, allowPrivateNetworks: false }))
  await proxy.start()
  t.after(() => proxy.close())
  const result = await requestThroughProxy(proxy.url, 'http://127.0.0.1:9/private')
  assert.equal(result.status, 403)
  assert.match(result.body, /Loopback access is denied/)
})
