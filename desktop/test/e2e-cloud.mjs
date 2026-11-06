import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'

import { chromium } from 'playwright'

import { startGateway } from '../src/main/gateway.mjs'

const repositoryRoot = fileURLToPath(new URL('../../', import.meta.url))
const rendererDir = join(repositoryRoot, 'desktop/dist-renderer')
const nextPort = Number(process.env.OPENLINK_E2E_CLOUD_PORT || 3101)
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
        OPENLINK_RUNTIME_MODE: 'cloud',
        OPENLINK_CLOUD_OAUTH_CLIENT_ID: 'desktop-e2e-client',
        OPENLINK_CLOUD_SUPABASE_URL: 'http://127.0.0.1:1',
        OPENLINK_CLOUD_SUPABASE_PUBLISHABLE_KEY: 'desktop-e2e-key',
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

  const capabilities = await (await fetch(`${nextUrl}/api/desktop/v1/capabilities`)).json()
  assert.equal(capabilities.runtimeMode, 'cloud')
  assert.ok(capabilities.auth.includes('hydite'))
  assert.equal(capabilities.publicConfig.hydite.clientId, 'desktop-e2e-client')
  assert.equal(capabilities.publicConfig.hydite.issuer, 'https://auth.hydite.com')
  assert.match(capabilities.publicConfig.hydite.redirectUri, /^http:\/\/127\.0\.0\.1:\d+\/auth\/hydite\/callback$/)

  gateway = await startGateway({
    rendererDir,
    upstreamUrl: nextUrl,
    port: 0,
    profile: { id: 'cloud-e2e', kind: 'cloud' },
    logger: { info() {}, error: console.error },
  })

  browser = await chromium.launch({ headless: true })
  const page = await browser.newPage({ viewport: { width: 1440, height: 940 } })
  const consoleErrors = []
  page.on('pageerror', (error) => consoleErrors.push(`pageerror: ${error.message}`))
  page.on('console', (message) => {
    if (message.type() !== 'error') return
    const text = message.text()
    if (/Failed to load resource: the server responded with a status of (401|409)/.test(text)) return
    consoleErrors.push(`console: ${text}`)
  })

  await page.goto(`${gateway.origin}/login`, { waitUntil: 'domcontentloaded' })
  await page.waitForSelector('text=Continue with Hydite', { timeout: 30_000 })
  assert.equal(await page.locator('input[name="email"]').count(), 0)
  await page.screenshot({ path: '/tmp/openlink-desktop-cloud-login.png', fullPage: false })
  assert.deepEqual(consoleErrors, [])

  process.stdout.write(
    `${JSON.stringify({
      ok: true,
      runtimeMode: capabilities.runtimeMode,
      auth: capabilities.auth,
      hydite: capabilities.publicConfig.hydite,
      screenshot: '/tmp/openlink-desktop-cloud-login.png',
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
