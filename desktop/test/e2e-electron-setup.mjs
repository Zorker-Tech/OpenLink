import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { existsSync } from 'node:fs'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'

import { _electron as electron } from 'playwright'

const repositoryRoot = fileURLToPath(new URL('../../', import.meta.url))
const desktopRoot = join(repositoryRoot, 'desktop')
const rendererDir = join(desktopRoot, 'dist-renderer')
const electronBinary =
  process.env.OPENLINK_ELECTRON_BINARY ||
  join(
    desktopRoot,
    'node_modules/electron/dist',
    process.platform === 'win32' ? 'electron.exe' : 'electron',
  )
const nextPort = Number(process.env.OPENLINK_E2E_SETUP_PORT || 3102)
const nextUrl = `http://127.0.0.1:${nextPort}`

if (!existsSync(join(rendererDir, 'index.html'))) {
  throw new Error('Build the desktop renderer first: npm --prefix desktop run build')
}

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
let app
let userData

try {
  next = startNext()
  await waitForHealth()
  userData = await mkdtemp(join(tmpdir(), 'openlink-electron-setup-'))

  app = await electron.launch({
    executablePath: electronBinary,
    args: ['--no-sandbox', '--disable-gpu', '--disable-dev-shm-usage', '.'],
    cwd: desktopRoot,
    env: {
      ...process.env,
      OPENLINK_DESKTOP_USER_DATA: userData,
      OPENLINK_DESKTOP_URL: '',
      OPENLINK_DESKTOP_CLOUD_URL: '',
    },
  })

  const window = await app.firstWindow({ timeout: 60_000 })
  await window.waitForSelector('text=Connect an OpenLink server', { timeout: 60_000 })
  const setupState = await window.evaluate(() => window.openLinkDesktop.getState())
  assert.equal(setupState.profiles.length, 0)
  assert.equal(setupState.activeProfileId, null)
  assert.equal(setupState.gateway?.setup, true)
  await window.screenshot({ path: '/tmp/openlink-electron-setup.png' })

  await window.getByRole('button', { name: /Connections/ }).click()
  await window.waitForSelector('text=Add a server', { timeout: 15_000 })
  await window.getByPlaceholder('Name').fill('Local server')
  await window.getByPlaceholder('https://openlink.example.com').fill(nextUrl)

  const nextWindowPromise = app.waitForEvent('window', { timeout: 90_000 })
  await window.getByRole('button', { name: 'Add server', exact: true }).click()
  const connected = await nextWindowPromise
  await connected.waitForSelector('input[name="email"]', { timeout: 90_000 })
  assert.equal(await connected.locator('textarea').count(), 0)
  const connectedState = await connected.evaluate(() => window.openLinkDesktop.getState())
  assert.equal(connectedState.profiles.length, 1)
  assert.equal(connectedState.profiles[0].kind, 'remote')
  assert.equal(connectedState.profiles[0].upstreamUrl, nextUrl)
  assert.equal(connectedState.activeProfileId, connectedState.profiles[0].id)
  assert.equal(connectedState.gateway?.setup, false)
  assert.equal(new URL(connected.url()).origin, connectedState.gateway.origin)
  await connected.screenshot({ path: '/tmp/openlink-electron-setup-connected.png' })

  process.stdout.write(
    `${JSON.stringify({
      ok: true,
      setup: setupState.gateway,
      profile: connectedState.profiles[0],
      gateway: connectedState.gateway,
      screenshots: [
        '/tmp/openlink-electron-setup.png',
        '/tmp/openlink-electron-setup-connected.png',
      ],
    }, null, 2)}\n`,
  )
} finally {
  await app?.close().catch(() => undefined)
  if (next?.child && next.child.exitCode === null) {
    next.child.kill('SIGTERM')
    await new Promise((resolve) => setTimeout(resolve, 500))
  }
  if (userData) await rm(userData, { recursive: true, force: true })
  if (next?.output?.length) {
    const text = next.output.join('')
    if (/error/i.test(text)) process.stderr.write(text.slice(-4_000))
  }
}
