import assert from 'node:assert/strict'
import { access, mkdtemp, rm } from 'node:fs/promises'
import { createServer, type Server } from 'node:http'
import { once } from 'node:events'
import test from 'node:test'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { chromium, type Browser, type Page } from 'playwright-core'
import { WebSocket } from 'ws'
import { BROWSER_PROTOCOL_VERSION, type BrowserActionEnvelope, type BrowserSocketServerMessage, type InspectorBridgeEnvelope, type InspectorBridgeEvent } from '@openlink/browser-protocol'
import { BrowserHostServer } from '../src/browser-server.js'
import type { BrowserHostConfig } from '../src/config.js'

type PreviewMessage = { origin: string; data: InspectorBridgeEnvelope }

declare global {
  interface Window {
    previewMessages?: PreviewMessage[]
  }
}

async function listen(server: Server): Promise<number> {
  server.listen(0, '127.0.0.1')
  await once(server, 'listening')
  const address = server.address()
  if (!address || typeof address === 'string') throw new Error('No TCP address')
  return address.port
}

async function close(server: Server): Promise<void> {
  if (!server.listening) return
  await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()))
}

async function waitFor<T>(read: () => T | undefined, description: string, timeoutMs = 5_000): Promise<T> {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    const value = read()
    if (value !== undefined) return value
    await new Promise((resolve) => setTimeout(resolve, 10))
  }
  throw new Error(`Timed out waiting for ${description}`)
}

test('real Chromium Preview iframe runs the injected inspector bridge and relays a DOM style action', async (t) => {
  const executablePath = process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH || chromium.executablePath()
  await access(executablePath)

  const upstream = createServer((_request, response) => {
    response.writeHead(200, {
      'Content-Type': 'text/html; charset=utf-8',
      'Content-Security-Policy': "default-src 'self'; script-src 'self'; frame-ancestors 'none'",
    })
    response.end('<!doctype html><html><head><title>Preview fixture</title></head><body><button id="apply">Apply style</button></body></html>')
  })
  const upstreamPort = await listen(upstream)

  let previewUrl = ''
  const parent = createServer((_request, response) => {
    const frameUrl = JSON.stringify(previewUrl)
    response.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' })
    response.end(`<!doctype html><html><body><iframe id="preview"></iframe><script>
      const frame = document.querySelector('#preview');
      window.previewMessages = [];
      window.addEventListener('message', (event) => {
        if (event.source === frame.contentWindow && event.data?.channel === 'openlink.browser.inspector') {
          window.previewMessages.push({ origin: event.origin, data: event.data });
        }
      });
      frame.src = ${frameUrl};
    </script></body></html>`)
  })
  const parentPort = await listen(parent)
  const parentOrigin = `http://127.0.0.1:${parentPort}`

  const portServer = createServer()
  portServer.listen(0, '127.0.0.1')
  await once(portServer, 'listening')
  const portAddress = portServer.address()
  if (!portAddress || typeof portAddress === 'string') throw new Error('No Browser Host TCP address')
  const hostPort = portAddress.port
  await close(portServer)
  const storageRoot = await mkdtemp(join(tmpdir(), 'openlink-preview-iframe-'))

  const config: BrowserHostConfig = {
    host: '127.0.0.1',
    port: hostPort,
    publicBaseUrl: `http://127.0.0.1:${hostPort}`,
    apiToken: 'a'.repeat(32),
    tokenSecret: 's'.repeat(32),
    allowedParentOrigins: [parentOrigin],
    storageRoot,
    maxSessions: 2,
    sessionTtlMs: 60_000,
    controlLeaseTtlMs: 5_000,
    shutdownTimeoutMs: 5_000,
  }
  const host = new BrowserHostServer(config)
  let browser: Browser | undefined
  let socket: WebSocket | undefined
  let page: Page | undefined
  t.after(async () => {
    socket?.close()
    await browser?.close()
    await host.close()
    await close(parent)
    await close(upstream)
    await rm(storageRoot, { recursive: true, force: true })
  })
  await host.listen()

  const createResponse = await fetch(`${config.publicBaseUrl}/v1/browser/sessions`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${config.apiToken}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({
      ownerId: 'integration-user',
      workspaceId: 'integration-workspace',
      projectId: '2c51ca26-3cd0-4cb4-896d-2061de06098c',
      surface: 'native-preview',
      preview: { targetUrl: `http://127.0.0.1:${upstreamPort}` },
    }),
  })
  assert.equal(createResponse.status, 201)
  const created = await createResponse.json() as {
    session: { id: string }
    connection: { previewUrl: string; eventsUrl: string }
  }
  previewUrl = created.connection.previewUrl

  browser = await chromium.launch({ executablePath, headless: true, args: ['--no-sandbox'] })
  page = await browser.newPage()
  const pageErrors: string[] = []
  page.on('pageerror', (error) => pageErrors.push(error.message))
  await page.goto(parentOrigin, { waitUntil: 'domcontentloaded' })
  await page.waitForFunction(() => window.previewMessages?.some((message) => message.data.payload?.type === 'bridge.ready'))

  socket = new WebSocket(created.connection.eventsUrl, { headers: { Origin: parentOrigin } })
  await once(socket, 'open')
  const messages: BrowserSocketServerMessage[] = []
  socket.on('message', (data) => messages.push(JSON.parse(data.toString()) as BrowserSocketServerMessage))

  const bridgeReady = await page.evaluate(() => window.previewMessages?.find((message) => message.data.payload?.type === 'bridge.ready')) as {
    origin: string
    data: InspectorBridgeEnvelope
  }
  assert.equal(bridgeReady.origin, config.publicBaseUrl)
  await page.evaluate(({ origin, data }) => {
    const frame = document.querySelector<HTMLIFrameElement>('#preview')!
    frame.contentWindow!.postMessage({
      channel: data.channel,
      version: data.version,
      sessionId: data.sessionId,
      nonce: data.nonce,
      payload: { type: 'inspect.start' },
    }, origin)
  }, bridgeReady)
  await page.frameLocator('#preview').getByRole('button', { name: 'Apply style' }).click()

  const selectedMessage = await page.waitForFunction(() => window.previewMessages?.find((message) => message.data.payload?.type === 'inspect.selected'))
  const selected = await selectedMessage.jsonValue() as { data: InspectorBridgeEnvelope<Extract<InspectorBridgeEvent, { type: 'inspect.selected' }>> }
  assert.equal(selected.data.payload.element.tagName, 'button')
  assert.ok(selected.data.payload.element.ref)

  const envelope: BrowserActionEnvelope = {
    version: BROWSER_PROTOCOL_VERSION,
    actionId: 'integration-style-set',
    sessionId: created.session.id,
    actor: 'human',
    action: {
      type: 'preview.style.set',
      pageId: 'preview',
      ref: selected.data.payload.element.ref,
      property: 'color',
      value: 'red',
    },
  }
  socket.send(JSON.stringify({ type: 'action', payload: envelope }))
  const commandMessage = await waitFor(
    () => messages.find((message): message is Extract<BrowserSocketServerMessage, { type: 'event' }> => (
      message.type === 'event' && message.payload.event.type === 'bridge.command'
      && message.payload.event.action.actionId === envelope.actionId
    )),
    'the DOM action bridge command',
  )
  if (commandMessage.type !== 'event' || commandMessage.payload.event.type !== 'bridge.command') throw new Error('Unexpected bridge event')

  await page.evaluate(({ origin, data, command }) => {
    const frame = document.querySelector<HTMLIFrameElement>('#preview')!
    frame.contentWindow!.postMessage({
      channel: data.channel,
      version: data.version,
      sessionId: data.sessionId,
      nonce: data.nonce,
      payload: { type: 'action.execute', envelope: command.action },
    }, origin)
  }, { origin: bridgeReady.origin, data: bridgeReady.data, command: commandMessage.payload.event })
  const actionResultMessage = await page.waitForFunction(() => window.previewMessages?.find((message) => (
    message.data.payload?.type === 'action.result'
    && message.data.payload.result?.actionId === 'integration-style-set'
  )))
  const actionResult = await actionResultMessage.jsonValue() as { data: InspectorBridgeEnvelope<Extract<InspectorBridgeEvent, { type: 'action.result' }>> }
  assert.equal(actionResult.data.payload.result.ok, true)
  assert.match(actionResult.data.payload.result.snapshot || '', /"color":"rgb\(255, 0, 0\)"/)

  socket.send(JSON.stringify({
    type: 'bridge.result',
    commandId: commandMessage.payload.event.commandId,
    result: actionResult.data.payload.result,
  }))
  const relayedResult = await waitFor(
    () => messages.find((message): message is Extract<BrowserSocketServerMessage, { type: 'event' }> => (
      message.type === 'event' && message.payload.event.type === 'action.result'
      && message.payload.event.result.actionId === envelope.actionId
    )),
    'the browser action result event',
  )
  assert.equal(relayedResult.type, 'event')
  assert.equal(relayedResult.payload.event.type === 'action.result' && relayedResult.payload.event.result.ok, true)
  const color = await page.frameLocator('#preview').getByRole('button', { name: 'Apply style' }).evaluate((element) => getComputedStyle(element).color)
  assert.equal(color, 'rgb(255, 0, 0)')
  assert.deepEqual(pageErrors, [])
})
