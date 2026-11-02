import assert from 'node:assert/strict'
import { mkdtemp, rm } from 'node:fs/promises'
import { createServer as createHttpServer, request as httpRequest } from 'node:http'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'

import { handleDesktopMcpRequest } from '../dist/desktop-mcp.js'

async function setup() {
  const root = await mkdtemp(join(tmpdir(), 'openlink-desktop-mcp-'))
  const socketPath = join(root, 'desktop.sock')
  const calls = []
  const bridge = createHttpServer((request, response) => {
    let body = ''
    request.on('data', (chunk) => { body += chunk.toString('utf8') })
    request.on('end', () => {
      const payload = JSON.parse(body)
      calls.push(payload.argv)
      const command = payload.argv.includes('screenshot') ? 'screenshot' : payload.argv[1] ?? payload.argv[0]
      const data = command === 'screenshot'
        ? { data: Buffer.from('png').toString('base64'), format: 'png', width: 1, height: 1, scale_factor: 1 }
        : { apps: [{ name: 'chrome', pid: 42 }] }
      response.writeHead(200, { 'content-type': 'application/json' })
      response.end(JSON.stringify({
        exitCode: 0,
        stdout: JSON.stringify({ version: '2.5', ok: true, command, data }),
        stderr: '',
      }))
    })
  })
  await new Promise((resolve, reject) => bridge.listen(socketPath, resolve).once('error', reject))
  const mcp = createHttpServer((request, response) => {
    void handleDesktopMcpRequest(request, response, socketPath)
  })
  await new Promise((resolve, reject) => mcp.listen(0, '127.0.0.1', resolve).once('error', reject))
  const address = mcp.address()
  const request = (body) => new Promise((resolve, reject) => {
    const payload = Buffer.from(JSON.stringify(body))
    const req = httpRequest({
      host: '127.0.0.1', port: address.port, path: '/', method: 'POST',
      headers: { 'content-type': 'application/json', 'content-length': payload.length, connection: 'close' },
    }, (response) => {
      const chunks = []
      response.on('data', (chunk) => chunks.push(chunk))
      response.on('end', () => resolve(JSON.parse(Buffer.concat(chunks).toString('utf8'))))
    })
    req.once('error', reject)
    req.end(payload)
  })
  return {
    calls,
    request,
    async close() {
      mcp.closeAllConnections?.()
      bridge.closeAllConnections?.()
      await new Promise((resolve) => mcp.close(resolve))
      await new Promise((resolve) => bridge.close(resolve))
      await rm(root, { recursive: true, force: true })
    },
  }
}

test('lists desktop tools and dispatches a typed list-apps call', { timeout: 10_000 }, async () => {
  const context = await setup()
  try {
    const list = await context.request({ jsonrpc: '2.0', id: 1, method: 'tools/list' })
    assert.ok(list.result.tools.some((tool) => tool.name === 'desktop_snapshot'))
    assert.ok(list.result.tools.some((tool) => tool.name === 'desktop_launch'))
    const called = await context.request({
      jsonrpc: '2.0', id: 2, method: 'tools/call',
      params: { name: 'desktop_list_apps', arguments: { app: 'chrome' } },
    })
    assert.equal(called.result.isError, false)
    assert.deepEqual(context.calls.at(-1), ['list-apps', '--app', 'chrome'])
  } finally {
    await context.close()
  }
})

test('builds constrained argv, rejects unknown tools, and returns screenshot images', { timeout: 10_000 }, async () => {
  const context = await setup()
  try {
    await context.request({
      jsonrpc: '2.0', id: 1, method: 'tools/call',
      params: { name: 'desktop_click', arguments: { ref: '@s1:e2' } },
    })
    assert.deepEqual(context.calls.at(-1), ['click', '@s1:e2'])
    const unknown = await context.request({
      jsonrpc: '2.0', id: 2, method: 'tools/call',
      params: { name: 'desktop_shell', arguments: {} },
    })
    assert.equal(unknown.error.code, -32602)
    const shot = await context.request({
      jsonrpc: '2.0', id: 3, method: 'tools/call',
      params: { name: 'desktop_screenshot', arguments: { screen: 0 } },
    })
    assert.equal(shot.result.content[0].type, 'image')
    assert.equal(shot.result.content[0].mimeType, 'image/png')
    assert.deepEqual(context.calls.at(-1), ['screenshot', '--screen', '0'])
  } finally {
    await context.close()
  }
})
