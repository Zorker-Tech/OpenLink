import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'

import { chromium } from 'playwright'

import { startGateway } from '../src/main/gateway.mjs'

const repositoryRoot = fileURLToPath(new URL('../../', import.meta.url))
const rendererDir = join(repositoryRoot, 'desktop/dist-renderer')
const nextPort = Number(process.env.OPENLINK_E2E_NEXT_PORT || 3100)
const nextUrl = `http://127.0.0.1:${nextPort}`

function startNext() {
  const child = spawn(
    process.execPath,
    ['node_modules/next/dist/bin/next', 'start', '-p', String(nextPort)],
    {
      cwd: repositoryRoot,
      env: {
        ...process.env,
        NODE_ENV: 'production',
        OPENLINK_STATIC_UI: '1',
        PORT: String(nextPort),
      },
      stdio: ['ignore', 'pipe', 'pipe'],
    },
  )
  const output = []
  child.stdout?.on('data', (chunk) => output.push(chunk.toString()))
  child.stderr?.on('data', (chunk) => output.push(chunk.toString()))
  return { child, output }
}

async function waitForHealth(timeoutMs = 90_000) {
  const deadline = Date.now() + timeoutMs
  let lastError
  while (Date.now() < deadline) {
    try {
      const response = await fetch(`${nextUrl}/api/healthz`, { cache: 'no-store' })
      if (response.ok) return
      lastError = new Error(`HTTP ${response.status}`)
    } catch (error) {
      lastError = error
    }
    await new Promise((resolve) => setTimeout(resolve, 500))
  }
  throw lastError ?? new Error('Next.js did not become healthy')
}

let next
let gateway
let browser

try {
  next = startNext()
  await waitForHealth()

  gateway = await startGateway({
    rendererDir,
    upstreamUrl: nextUrl,
    port: 0,
    profile: { id: 'e2e', kind: 'remote' },
    logger: { info() {}, error: console.error },
  })

  browser = await chromium.launch({ headless: true })
  const page = await browser.newPage({ viewport: { width: 1440, height: 940 } })
  const consoleErrors = []
  page.on('pageerror', (error) => consoleErrors.push(`pageerror: ${error.message}`))
  page.on('console', (message) => {
    if (message.type() !== 'error') return
    const text = message.text()
    // The auth guard intentionally returns 401/409 so the client can navigate
    // to the login route. Chromium logs those as resource load errors.
    if (/Failed to load resource: the server responded with a status of (401|409)/.test(text)) return
    consoleErrors.push(`console: ${text}`)
  })

  const capabilities = await (await fetch(`${gateway.origin}/api/desktop/v1/capabilities`)).json()
  assert.equal(capabilities.apiVersion, 1)
  assert.ok(capabilities.features.includes('bootstrap.chat'))
  assert.equal(capabilities.runtimeMode, 'local')
  assert.equal(capabilities.publicConfig.hydite, null)

  const protectedBootstrap = await fetch(`${gateway.origin}/api/desktop/v1/bootstrap/settings`)
  assert.equal(protectedBootstrap.status, 401)
  const protectedPayload = await protectedBootstrap.json()
  assert.match(protectedPayload.redirect, /^\/login\?next=/)

  const unknownAction = await fetch(`${gateway.origin}/api/desktop/v1/actions`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', origin: gateway.origin },
    body: JSON.stringify({ action: 'does.not.exist' }),
  })
  assert.equal(unknownAction.status, 404)

  const publicAsset = await fetch(`${gateway.origin}/openlink/navigation/home.svg`)
  assert.equal(publicAsset.status, 200)
  assert.match(publicAsset.headers.get('content-type'), /svg/)

  const shellHtml = await (await fetch(`${gateway.origin}/app/example`)).text()
  assert.match(shellHtml, /name="openlink-desktop-profile-kind" content="remote"/)

  // The desktop client has no marketing home. `/` resolves the app entry: an
  // anonymous static-UI session lands on login, and the composer textarea is
  // not part of the desktop surface.
  await page.goto(`${gateway.origin}/`, { waitUntil: 'domcontentloaded' })
  await page.waitForSelector('input[name="email"]', { timeout: 30_000 })
  assert.equal(await page.title(), 'OpenLink')
  assert.equal(await page.locator('textarea').count(), 0)
  await page.screenshot({ path: '/tmp/openlink-desktop-root.png', fullPage: false })

  await page.goto(`${gateway.origin}/login`, { waitUntil: 'domcontentloaded' })
  await page.waitForSelector('input[name="email"]', { timeout: 30_000 })
  assert.equal(await page.locator('input[name="password"]').count(), 1)
  await page.screenshot({ path: '/tmp/openlink-desktop-login.png', fullPage: false })

  await page.goto(`${gateway.origin}/app`, { waitUntil: 'domcontentloaded' })
  await page.waitForSelector('input[name="email"]', { timeout: 30_000 })

  await page.goto(`${gateway.origin}/settings`, { waitUntil: 'domcontentloaded' })
  await page.waitForSelector('input[name="email"]', { timeout: 30_000 })

  // Connection management is an Electron bridge surface. Inject the same
  // contract the preload exposes to verify the renderer-side workflow.
  await page.addInitScript(() => {
    window.openLinkDesktop = {
      version: 1,
      getState: async () => ({
        profiles: [
          { id: 'staging', kind: 'remote', name: 'Staging', upstreamUrl: 'https://staging.example.com', gatewayPort: 43126 },
          { id: 'production', kind: 'cloud', name: 'Production', upstreamUrl: 'https://cloud.example.com', gatewayPort: 43127 },
        ],
        activeProfileId: 'staging',
        gateway: { origin: location.origin },
        platform: 'linux',
        versions: { electron: '44.9.0', chrome: '140.0.0.0', node: '22.22.1' },
      }),
      listProfiles: async () => [],
      upsertProfile: async (profile) => ({ ...profile, id: 'new-profile' }),
      removeProfile: async () => true,
      activateProfile: async () => ({}),
      openExternal: async () => true,
      auth: { hydite: async () => ({ code: 'test-code' }) },
      onStateChanged: () => () => {},
      onOpenConnections: () => () => {},
    }
  })
  await page.goto(`${gateway.origin}/`, { waitUntil: 'domcontentloaded' })
  await page.waitForSelector('input[name="email"]', { timeout: 30_000 })
  await page.getByRole('button', { name: 'Connections' }).click()
  await page.waitForSelector('text=OpenLink Desktop', { timeout: 15_000 })
  await page.waitForSelector('text=Add a server', { timeout: 15_000 })
  assert.equal(await page.getByText('Staging', { exact: true }).count(), 1)
  assert.equal(await page.getByText('Production', { exact: true }).count(), 1)
  assert.equal(await page.getByText('Local runtime', { exact: false }).count(), 0)
  await page.screenshot({ path: '/tmp/openlink-desktop-connections.png', fullPage: false })

  assert.deepEqual(consoleErrors, [])

  process.stdout.write(
    `${JSON.stringify({
      ok: true,
      gateway: gateway.origin,
      next: nextUrl,
      capabilities: {
        apiVersion: capabilities.apiVersion,
        runtimeMode: capabilities.runtimeMode,
        features: capabilities.features.length,
      },
      screenshots: [
        '/tmp/openlink-desktop-root.png',
        '/tmp/openlink-desktop-login.png',
        '/tmp/openlink-desktop-connections.png',
      ],
    }, null, 2)}\n`,
  )
} finally {
  await browser?.close().catch(() => undefined)
  await gateway?.close().catch(() => undefined)
  if (next?.child && next.child.exitCode === null) {
    next.child.kill('SIGTERM')
    await new Promise((resolve) => setTimeout(resolve, 500))
  }
  if (next?.output?.length) {
    const text = next.output.join('')
    if (/error/i.test(text)) process.stderr.write(text.slice(-4_000))
  }
}
