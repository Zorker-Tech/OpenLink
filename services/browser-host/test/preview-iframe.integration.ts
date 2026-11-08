import assert from 'node:assert/strict'
import { access, mkdtemp, rm } from 'node:fs/promises'
import { createServer, type Server } from 'node:http'
import { once } from 'node:events'
import test from 'node:test'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { chromium, type Browser, type Page } from 'playwright-core'
import { WebSocket, WebSocketServer } from 'ws'
import { BROWSER_PROTOCOL_VERSION, previewPagePathFromAddress, type BrowserActionEnvelope, type BrowserSocketServerMessage, type InspectorBridgeEnvelope, type InspectorBridgeEvent } from '@openlink/browser-protocol'
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

test('real Chromium Preview iframe restores routes and proxies assets, HMR WebSockets, cookies, and inspector actions', async (t) => {
  const executablePath = process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH || chromium.executablePath()
  await access(executablePath)

  const upstreamPaths: string[] = []
  const upstream = createServer((request, response) => {
    upstreamPaths.push(request.url || '/')
    if (request.url === '/assets/preview.js') {
      response.writeHead(200, { 'Content-Type': 'text/javascript; charset=utf-8' })
      response.end(`
        document.documentElement.dataset.previewAsset = 'loaded';
        const dynamicImage = new Image();
        dynamicImage.addEventListener('load', () => { document.documentElement.dataset.dynamicAsset = 'loaded'; });
        dynamicImage.src = '/assets/dynamic.svg';
        document.addEventListener('DOMContentLoaded', () => document.body.append(dynamicImage));
        fetch('/api/health').then((response) => response.text()).then((value) => { document.documentElement.dataset.fetchResult = value; });
        const xhr = new XMLHttpRequest();
        xhr.addEventListener('load', () => { document.documentElement.dataset.xhrResult = xhr.responseText; });
        xhr.open('GET', '/api/xhr');
        xhr.send();
        const socketUrl = new URL('/__hmr', location.href);
        socketUrl.protocol = location.protocol === 'https:' ? 'wss:' : 'ws:';
        const socket = new WebSocket(socketUrl);
        socket.addEventListener('open', () => { document.documentElement.dataset.hmrState = 'open'; socket.send('hmr-ping'); });
        socket.addEventListener('message', (event) => { document.documentElement.dataset.hmrResult = event.data; socket.close(); });
        socket.addEventListener('error', () => { document.documentElement.dataset.hmrState = 'error'; });
        document.addEventListener('click', (event) => {
          const link = event.target.closest?.('#route-link');
          if (link) { event.preventDefault(); document.documentElement.dataset.routeClick = link.pathname; }
          const programmaticRoute = event.target.closest?.('#route-programmatic');
          if (programmaticRoute) {
            document.documentElement.dataset.routeAttempt = 'true';
            history.pushState({}, '', location.pathname + '/settings?token=must-not-persist');
          }
        });
      `)
      return
    }
    if (request.url === '/api/health' || request.url === '/api/xhr') {
      response.writeHead(200, { 'Content-Type': 'text/plain; charset=utf-8' })
      response.end(request.url === '/api/health' ? 'fetch-ok' : 'xhr-ok')
      return
    }
    if (request.url === '/assets/preview-module.js') {
      response.writeHead(200, { 'Content-Type': 'text/javascript; charset=utf-8' })
      response.end("import '/assets/module-ping.js'")
      return
    }
    if (request.url === '/assets/module-ping.js') {
      response.writeHead(200, { 'Content-Type': 'text/javascript; charset=utf-8' })
      response.end("document.documentElement.dataset.previewModule = 'loaded'")
      return
    }
    if (request.url === '/assets/preview.css') {
      response.writeHead(200, { 'Content-Type': 'text/css; charset=utf-8' })
      response.end("body{background-image:url('/assets/background.svg')}")
      return
    }
    if (request.url === '/assets/background.svg' || request.url === '/assets/preload.svg' || request.url === '/assets/image.svg' || request.url === '/assets/dynamic.svg') {
      response.writeHead(200, { 'Content-Type': 'image/svg+xml' })
      response.end('<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 1 1"><path fill="red" d="M0 0h1v1H0z"/></svg>')
      return
    }
    response.writeHead(200, {
      'Content-Type': 'text/html; charset=utf-8',
      'Content-Security-Policy': "default-src 'self'; script-src 'self'; frame-ancestors 'none'",
      'Link': '</assets/preload.svg>; rel=preload; as=image',
      'Set-Cookie': 'preview-app=ready; Path=/; HttpOnly; SameSite=Lax',
    })
    response.end('<!doctype html><html><head><title>Preview fixture</title><link rel=stylesheet href=/assets/preview.css><script src="/assets/preview.js"></script><script type="module" src="/assets/preview-module.js"></script></head><body><img src="/assets/image.svg"><a id="route-link" href="/about">About</a><a id="external-link" href="https://example.invalid/">External</a><button id="route-programmatic">Navigate with SPA</button><button id="apply" data-testid="apply-style">Apply style</button></body></html>')
  })
  const upstreamPort = await listen(upstream)
  const upstreamWebSockets = new WebSocketServer({ noServer: true })
  const upstreamWebSocketCookies: string[] = []
  upstream.on('upgrade', (request, socket, head) => {
    if (request.url !== '/__hmr') {
      socket.destroy()
      return
    }
    upstreamWebSocketCookies.push(request.headers.cookie || '')
    upstreamWebSockets.handleUpgrade(request, socket, head, (webSocket) => {
      webSocket.on('message', (data) => {
        webSocket.send(data.toString() === 'hmr-ping' ? 'hmr-pong' : 'unexpected-message', () => webSocket.close())
      })
    })
  })

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
    await new Promise<void>((resolve) => upstreamWebSockets.close(() => resolve()))
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
  const bootstrapUrl = new URL(created.connection.previewUrl)
  bootstrapUrl.searchParams.set('path', '/dashboard')
  previewUrl = bootstrapUrl.toString()

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
  const restoredUrl = new URL((bridgeReady.data.payload as Extract<InspectorBridgeEvent, { type: 'bridge.ready' }>).url)
  assert.equal(restoredUrl.pathname, `/v1/browser/sessions/${created.session.id}/preview/dashboard`)
  assert.ok(upstreamPaths.includes('/dashboard'))
  await page.frameLocator('#preview').locator('html').waitFor()
  const hmrResult = await page.frameLocator('#preview').locator('html').evaluate(async (element) => {
    const deadline = Date.now() + 5_000
    while (Date.now() < deadline) {
      if (element.dataset.hmrResult && element.dataset.fetchResult && element.dataset.xhrResult && element.dataset.dynamicAsset) {
        return { result: element.dataset.hmrResult, state: element.dataset.hmrState, asset: element.dataset.previewAsset, module: element.dataset.previewModule, fetch: element.dataset.fetchResult, xhr: element.dataset.xhrResult, dynamicAsset: element.dataset.dynamicAsset }
      }
      await new Promise((resolve) => setTimeout(resolve, 10))
    }
    return { result: element.dataset.hmrResult, state: element.dataset.hmrState, asset: element.dataset.previewAsset, module: element.dataset.previewModule, fetch: element.dataset.fetchResult, xhr: element.dataset.xhrResult, dynamicAsset: element.dataset.dynamicAsset }
  })
  assert.deepEqual(hmrResult, { result: 'hmr-pong', state: 'open', asset: 'loaded', module: 'loaded', fetch: 'fetch-ok', xhr: 'xhr-ok', dynamicAsset: 'loaded' }, `upstream=${JSON.stringify(upstreamPaths)} cookies=${JSON.stringify(upstreamWebSocketCookies)}`)
  assert.ok(upstreamPaths.includes('/api/health'))
  assert.ok(upstreamPaths.includes('/api/xhr'))
  assert.ok(upstreamPaths.includes('/assets/dynamic.svg'))
  assert.ok(upstreamPaths.includes('/assets/preview.js'))
  assert.ok(upstreamPaths.includes('/assets/preview-module.js'))
  assert.ok(upstreamPaths.includes('/assets/module-ping.js'))
  assert.ok(upstreamPaths.includes('/assets/preview.css'))
  assert.ok(upstreamPaths.includes('/assets/background.svg'), JSON.stringify(upstreamPaths))
  assert.ok(upstreamPaths.includes('/assets/image.svg'))
  assert.ok(upstreamPaths.includes('/assets/preload.svg'))
  assert.ok(upstreamWebSocketCookies.some((cookie) => cookie.includes('preview-app=ready')))
  await page.frameLocator('#preview').getByRole('link', { name: 'About' }).click()
  const routeClickPath = await page.frameLocator('#preview').locator('html').getAttribute('data-route-click')
  assert.equal(routeClickPath, `/v1/browser/sessions/${created.session.id}/preview/about`)
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

  await page.frameLocator('#preview').locator('#apply').evaluate((element) => {
    const replacement = document.createElement('button')
    replacement.id = 'replacement'
    replacement.dataset.testid = 'apply-style'
    replacement.style.color = getComputedStyle(element).color
    replacement.textContent = 'Apply style'
    element.replaceWith(replacement)
  })
  const locatorEnvelope: BrowserActionEnvelope = {
    version: BROWSER_PROTOCOL_VERSION,
    actionId: 'integration-locator-resolve',
    sessionId: created.session.id,
    actor: 'human',
    action: {
      type: 'preview.locator.resolve',
      pageId: 'preview',
      locator: {
        version: 1,
        tagName: 'button',
        candidates: [
          { kind: 'data-testid', value: 'apply-style' },
          { kind: 'id', value: 'apply' },
          { kind: 'css', value: '#apply' },
        ],
      },
    },
  }
  socket.send(JSON.stringify({ type: 'action', payload: locatorEnvelope }))
  const locatorCommand = await waitFor(
    () => messages.find((message): message is Extract<BrowserSocketServerMessage, { type: 'event' }> => (
      message.type === 'event' && message.payload.event.type === 'bridge.command'
      && message.payload.event.action.actionId === locatorEnvelope.actionId
    )),
    'the locator resolution bridge command',
  )
  if (locatorCommand.type !== 'event' || locatorCommand.payload.event.type !== 'bridge.command') throw new Error('Unexpected locator bridge event')
  await page.evaluate(({ origin, data, command }) => {
    const frame = document.querySelector<HTMLIFrameElement>('#preview')!
    frame.contentWindow!.postMessage({
      channel: data.channel,
      version: data.version,
      sessionId: data.sessionId,
      nonce: data.nonce,
      payload: { type: 'action.execute', envelope: command.action },
    }, origin)
  }, { origin: bridgeReady.origin, data: bridgeReady.data, command: locatorCommand.payload.event })
  const locatorResultMessage = await page.waitForFunction((actionId) => window.previewMessages?.find((message) => (
    message.data.payload?.type === 'action.result'
    && message.data.payload.result?.actionId === actionId
  )), locatorEnvelope.actionId)
  const locatorResult = await locatorResultMessage.jsonValue() as { data: InspectorBridgeEnvelope<Extract<InspectorBridgeEvent, { type: 'action.result' }>> }
  assert.equal(locatorResult.data.payload.result.ok, true)
  assert.equal(locatorResult.data.payload.result.element?.attributes.id, 'replacement')
  assert.match(locatorResult.data.payload.result.snapshot || '', /"status":"matched"/)
  socket.send(JSON.stringify({ type: 'bridge.result', commandId: locatorCommand.payload.event.commandId, result: locatorResult.data.payload.result }))
  await waitFor(
    () => messages.find((message): message is Extract<BrowserSocketServerMessage, { type: 'event' }> => (
      message.type === 'event' && message.payload.event.type === 'action.result'
      && message.payload.event.result.actionId === locatorEnvelope.actionId
    )),
    'the relayed locator resolution result',
  )

  await page.frameLocator('#preview').locator('#replacement').evaluate((element) => {
    const duplicate = document.createElement('button')
    duplicate.dataset.testid = 'apply-style'
    duplicate.textContent = 'Another action'
    element.after(duplicate)
  })
  const ambiguousLocatorEnvelope: BrowserActionEnvelope = {
    ...locatorEnvelope,
    actionId: 'integration-locator-ambiguous',
    action: locatorEnvelope.action,
  }
  socket.send(JSON.stringify({ type: 'action', payload: ambiguousLocatorEnvelope }))
  const ambiguousCommand = await waitFor(
    () => messages.find((message): message is Extract<BrowserSocketServerMessage, { type: 'event' }> => (
      message.type === 'event' && message.payload.event.type === 'bridge.command'
      && message.payload.event.action.actionId === ambiguousLocatorEnvelope.actionId
    )),
    'the ambiguous locator bridge command',
  )
  if (ambiguousCommand.type !== 'event' || ambiguousCommand.payload.event.type !== 'bridge.command') throw new Error('Unexpected ambiguous locator bridge event')
  await page.evaluate(({ origin, data, command }) => {
    const frame = document.querySelector<HTMLIFrameElement>('#preview')!
    frame.contentWindow!.postMessage({
      channel: data.channel,
      version: data.version,
      sessionId: data.sessionId,
      nonce: data.nonce,
      payload: { type: 'action.execute', envelope: command.action },
    }, origin)
  }, { origin: bridgeReady.origin, data: bridgeReady.data, command: ambiguousCommand.payload.event })
  const ambiguousResultMessage = await page.waitForFunction((actionId) => window.previewMessages?.find((message) => (
    message.data.payload?.type === 'action.result'
    && message.data.payload.result?.actionId === actionId
  )), ambiguousLocatorEnvelope.actionId)
  const ambiguousResult = await ambiguousResultMessage.jsonValue() as { data: InspectorBridgeEnvelope<Extract<InspectorBridgeEvent, { type: 'action.result' }>> }
  assert.equal(ambiguousResult.data.payload.result.ok, true)
  assert.equal(ambiguousResult.data.payload.result.element, undefined)
  assert.match(ambiguousResult.data.payload.result.snapshot || '', /"status":"ambiguous"/)
  socket.send(JSON.stringify({ type: 'bridge.result', commandId: ambiguousCommand.payload.event.commandId, result: ambiguousResult.data.payload.result }))

  await page.evaluate(({ origin, data }) => {
    const frame = document.querySelector<HTMLIFrameElement>('#preview')!
    frame.contentWindow!.postMessage({
      channel: data.channel,
      version: data.version,
      sessionId: data.sessionId,
      nonce: data.nonce,
      payload: { type: 'inspect.stop' },
    }, origin)
  }, bridgeReady)
  const nextAddress = `${restoredUrl.pathname}/settings?token=must-not-persist`
  await page.evaluate(({ origin, data }) => {
    const frame = document.querySelector<HTMLIFrameElement>('#preview')!
    frame.contentWindow!.postMessage({
      channel: data.channel,
      version: data.version,
      sessionId: data.sessionId,
      nonce: data.nonce,
      payload: {
        type: 'preview.pending-changes',
        hasPendingChanges: true,
        confirmationMessage: 'Preview has unapplied changes. Continue?',
      },
    }, origin)
  }, { origin: bridgeReady.origin, data: bridgeReady.data })
  const dismissExternalNavigationDialog = page.waitForEvent('dialog', { timeout: 5_000 }).then((dialog) => dialog.dismiss())
  await page.frameLocator('#preview').getByRole('link', { name: 'External' }).click()
  await dismissExternalNavigationDialog
  assert.equal(await page.frameLocator('#preview').locator('body').evaluate(() => location.pathname), restoredUrl.pathname)
  const dismissNavigationDialog = page.waitForEvent('dialog', { timeout: 5_000 }).then(async (dialog) => {
    assert.match(dialog.message(), /Preview has unapplied changes/)
    await dialog.dismiss()
  }).catch(async (error) => {
    const state = await page.frameLocator('#preview').locator('html').evaluate((element) => ({
      routeAttempt: element.dataset.routeAttempt,
      pathname: location.pathname,
    }))
    throw new Error(`No confirmation dialog for SPA navigation: ${String(error)} ${JSON.stringify(state)}`)
  })
  await page.frameLocator('#preview').getByRole('button', { name: 'Navigate with SPA' }).click()
  await dismissNavigationDialog
  assert.equal(await page.frameLocator('#preview').locator('body').evaluate(() => location.pathname), restoredUrl.pathname)

  const acceptNavigationDialog = page.waitForEvent('dialog', { timeout: 5_000 }).then((dialog) => dialog.accept())
  const updatedMessagePromise = page.waitForFunction(() => window.previewMessages?.find((message) => message.data.payload?.type === 'page.updated'))
  await page.frameLocator('#preview').getByRole('button', { name: 'Navigate with SPA' }).click()
  await acceptNavigationDialog
  const updatedMessage = await updatedMessagePromise
  const updated = await updatedMessage.jsonValue() as { data: InspectorBridgeEnvelope<Extract<InspectorBridgeEvent, { type: 'page.updated' }>> }
  assert.equal(previewPagePathFromAddress(updated.data.payload.url), '/dashboard/settings')
  assert.equal(new URL(updated.data.payload.url).search, '?token=must-not-persist')

  const dismissHistoryNavigationDialog = page.waitForEvent('dialog', { timeout: 5_000 }).then((dialog) => dialog.dismiss())
  await page.frameLocator('#preview').locator('body').evaluate(() => history.back())
  await dismissHistoryNavigationDialog
  assert.match(await page.frameLocator('#preview').locator('body').evaluate(() => location.pathname), /\/dashboard\/settings$/)

  const pageUpdateCount = await page.evaluate(() => window.previewMessages?.filter((message) => message.data.payload?.type === 'page.updated').length ?? 0)
  const historyBackUpdate = page.waitForFunction((previousCount) => (
    (window.previewMessages?.filter((message) => message.data.payload?.type === 'page.updated').length ?? 0) > previousCount
    && window.previewMessages?.some((message) => message.data.payload?.type === 'page.updated'
      && new URL(message.data.payload.url).pathname.endsWith('/dashboard'))
  ), pageUpdateCount)
  const acceptHistoryNavigationDialog = page.waitForEvent('dialog', { timeout: 5_000 }).then((dialog) => dialog.accept())
  await page.frameLocator('#preview').locator('body').evaluate(() => history.back())
  await acceptHistoryNavigationDialog
  await historyBackUpdate
  assert.equal(await page.frameLocator('#preview').locator('body').evaluate(() => location.pathname), restoredUrl.pathname)
  const color = await page.frameLocator('#preview').getByRole('button', { name: 'Apply style' }).evaluate((element) => getComputedStyle(element).color)
  assert.equal(color, 'rgb(255, 0, 0)')
  assert.deepEqual(pageErrors, [])
})
