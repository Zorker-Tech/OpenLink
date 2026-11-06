import assert from 'node:assert/strict'
import { createServer } from 'node:net'
import { test } from 'node:test'

import { createDesktopAuth } from '../src/main/auth.mjs'

const silentLogger = { info() {} }

async function freePort() {
  const server = createServer()
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
  const port = server.address().port
  await new Promise((resolve) => server.close(resolve))
  return port
}

const STATE = 'a'.repeat(32)

function options(port, state = STATE) {
  return {
    authorizationUrl: `https://auth.example.com/authorize?client_id=desktop&state=${state}`,
    redirectUri: `http://127.0.0.1:${port}/auth/hydite/callback`,
    state,
    timeoutMs: 5_000,
  }
}

test('completes a Hydite loopback sign-in with the matching state', async () => {
  const port = await freePort()
  let opened = null
  const auth = createDesktopAuth({
    logger: silentLogger,
    openExternal: async (url) => {
      opened = url
      const state = new URL(url).searchParams.get('state')
      const response = await fetch(
        `http://127.0.0.1:${port}/auth/hydite/callback?code=code-123&state=${state}`,
      )
      assert.equal(response.status, 200)
      assert.match(await response.text(), /Signed in/)
    },
  })
  const result = await auth.hydite(options(port))
  assert.deepEqual(result, { code: 'code-123' })
  assert.match(opened, /auth\.example\.com/)
})

test('rejects a callback with a mismatched state', async () => {
  const port = await freePort()
  const auth = createDesktopAuth({
    logger: silentLogger,
    openExternal: async (url) => {
      const state = new URL(url).searchParams.get('state')
      await fetch(
        `http://127.0.0.1:${port}/auth/hydite/callback?code=code-123&state=${state}-wrong`,
      ).catch(() => undefined)
    },
  })
  await assert.rejects(auth.hydite(options(port)), /invalid state/)
})

test('rejects provider errors and missing codes', async () => {
  const port = await freePort()
  const auth = createDesktopAuth({
    logger: silentLogger,
    openExternal: async (url) => {
      const state = new URL(url).searchParams.get('state')
      await fetch(
        `http://127.0.0.1:${port}/auth/hydite/callback?error=access_denied&state=${state}`,
      ).catch(() => undefined)
    },
  })
  await assert.rejects(auth.hydite(options(port)), /access_denied/)
})

test('times out and releases the listener', async () => {
  const port = await freePort()
  const auth = createDesktopAuth({
    logger: silentLogger,
    openExternal: async () => undefined,
  })
  await assert.rejects(
    auth.hydite({ ...options(port), timeoutMs: 150 }),
    /timed out/,
  )
})

test('only one interactive sign-in is allowed at a time', async () => {
  const port = await freePort()
  let release
  const auth = createDesktopAuth({
    logger: silentLogger,
    openExternal: () => new Promise((resolve) => { release = resolve }),
  })
  const first = auth.hydite({ ...options(port), timeoutMs: 5_000 })
  await new Promise((resolve) => setTimeout(resolve, 50))
  await assert.rejects(auth.hydite(options(port)), /already in progress/)
  auth.cancel()
  await assert.rejects(first, /cancelled/)
  release?.()
})

test('validates the redirect URI and state before listening', async () => {
  const auth = createDesktopAuth({ logger: silentLogger, openExternal: async () => undefined })
  await assert.rejects(
    auth.hydite({
      ...options(43127),
      redirectUri: 'https://example.com/auth/hydite/callback',
    }),
    /loopback/,
  )
  await assert.rejects(
    auth.hydite({ ...options(43127), state: 'short' }),
    /state value is invalid/,
  )
})
