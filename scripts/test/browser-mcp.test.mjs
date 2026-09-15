import assert from 'node:assert/strict'
import { createServer } from 'node:http'
import { mkdtemp, writeFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { handleBrowserMcpRequest } from '../../services/agent-worker/dist/browser-mcp.js'

test('Browser tools remain installed and consume a capability bound after initialization', async (context) => {
  const directory = await mkdtemp(join(tmpdir(), 'openlink-late-browser-'))
  const file = join(directory, 'capability.json')
  await writeFile(file, 'null')
  const host = createServer((request, response) => {
    assert.equal(request.headers.authorization, 'Bearer bound-token')
    response.writeHead(200, { 'Content-Type': 'application/json' })
    response.end(JSON.stringify({ result: { ok: true, snapshot: 'late-bound page' } }))
  })
  await new Promise((resolve) => host.listen(0, '127.0.0.1', resolve))
  const bridge = createServer((request, response) => {
    void handleBrowserMcpRequest(request, response, file)
  })
  await new Promise((resolve) => bridge.listen(0, '127.0.0.1', resolve))
  context.after(async () => {
    await Promise.all([new Promise((resolve) => bridge.close(resolve)), new Promise((resolve) => host.close(resolve))])
    await rm(directory, { recursive: true, force: true })
  })
  const call = async (method, params = {}) => {
    const response = await fetch(`http://127.0.0.1:${bridge.address().port}`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }),
    })
    return response.json()
  }
  await call('initialize')
  const before = await call('tools/list')
  assert.ok(before.result.tools.some((tool) => tool.name === 'browser_read'))
  await writeFile(file, JSON.stringify({
    hostUrl: `http://127.0.0.1:${host.address().port}`,
    sessionId: 'late-browser-session', controlToken: 'bound-token',
  }))
  const result = await call('tools/call', { name: 'browser_read', arguments: { pageId: 'page' } })
  assert.equal(result.result.isError, false)
  assert.equal(result.result.content[0].text, 'late-bound page')
})

test('Codex Browser bridge exposes native MCP tools and safety annotations', async (context) => {
  const server = createServer((request, response) => {
    void handleBrowserMcpRequest(request, response, '/missing/browser-capability.json')
  })
  await new Promise((resolve, reject) => server.listen(0, '127.0.0.1', resolve).once('error', reject))
  context.after(() => new Promise((resolve) => server.close(resolve)))
  const address = server.address()
  assert.ok(address && typeof address === 'object')
  const call = async (body) => {
    const response = await fetch(`http://127.0.0.1:${address.port}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    })
    assert.equal(response.status, 200)
    return response.json()
  }
  const initialized = await call({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-06-18' } })
  assert.equal(initialized.result.serverInfo.name, 'openlink-browser')
  const listed = await call({ jsonrpc: '2.0', id: 2, method: 'tools/list' })
  const tools = listed.result.tools
  assert.equal(tools.find((tool) => tool.name === 'browser_read').annotations.readOnlyHint, true)
  assert.equal(tools.find((tool) => tool.name === 'browser_type').annotations.readOnlyHint, false)
  assert.ok(tools.some((tool) => tool.name === 'browser_screenshot'))
})
