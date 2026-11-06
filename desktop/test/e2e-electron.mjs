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
const nextPort = Number(process.env.OPENLINK_E2E_NEXT_PORT || 3100)
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
  userData = await mkdtemp(join(tmpdir(), 'openlink-electron-'))

  app = await electron.launch({
    executablePath: electronBinary,
    args: [
      '--no-sandbox',
      '--disable-gpu',
      '--disable-dev-shm-usage',
      '.',
    ],
    cwd: desktopRoot,
    env: {
      ...process.env,
      OPENLINK_DESKTOP_URL: nextUrl,
      OPENLINK_DESKTOP_PROFILE_NAME: 'Staging',
      OPENLINK_DESKTOP_USER_DATA: userData,
    },
  })

  const window = await app.firstWindow({ timeout: 60_000 })
  // The desktop has no marketing home: `/` resolves the app entry and an
  // unauthenticated static-UI session lands on login.
  await window.waitForSelector('input[name="email"]', { timeout: 60_000 })
  assert.equal(await window.title(), 'OpenLink')
  assert.equal(await window.locator('textarea').count(), 0)

  const state = await window.evaluate(() => window.openLinkDesktop.getState())
  assert.equal(state.profiles.length, 1)
  assert.equal(state.profiles[0].kind, 'remote')
  assert.equal(state.profiles[0].name, 'Staging')
  assert.match(state.gateway.origin, /^http:\/\/127\.0\.0\.1:\d+$/)
  assert.equal(await window.evaluate(() => window.location.origin), state.gateway.origin)
  assert.equal(await window.evaluate(() => window.openLinkDesktop.version), 1)
  await window.screenshot({ path: '/tmp/openlink-electron-root.png' })

  await window.getByRole('button', { name: 'Connections' }).click()
  await window.waitForSelector('text=OpenLink Desktop', { timeout: 15_000 })
  assert.ok((await window.getByText('Staging', { exact: true }).count()) > 0)
  assert.ok((await window.getByText('Active server', { exact: false }).count()) > 0)
  assert.equal(await window.getByText('Local runtime', { exact: false }).count(), 0)
  await window.screenshot({ path: '/tmp/openlink-electron-connections.png' })

  await window.goto(`${state.gateway.origin}/login`, { waitUntil: 'domcontentloaded' })
  await window.waitForSelector('input[name="email"]', { timeout: 30_000 })
  await window.screenshot({ path: '/tmp/openlink-electron-login.png' })

  process.stdout.write(
    `${JSON.stringify({
      ok: true,
      gateway: state.gateway.origin,
      profile: state.profiles[0],
      electron: state.versions.electron,
      chrome: state.versions.chrome,
      screenshots: [
        '/tmp/openlink-electron-root.png',
        '/tmp/openlink-electron-connections.png',
        '/tmp/openlink-electron-login.png',
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
