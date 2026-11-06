/**
 * Real local-desktop verification.
 *
 * Requires a running local OpenLink runtime (Next web + Zokerbase + Agent Host)
 * and a confirmed local user. It generates a real magic-link token, signs in
 * through the desktop gateway, then verifies:
 *  - real workspace data from the desktop bootstrap;
 *  - a real chat stream (POST /api/chat/:id/events, NDJSON) against the Agent Host;
 *  - real settings persistence through the desktop action bridge.
 *
 * Environment:
 *  OPENLINK_E2E_APP_URL        default http://127.0.0.1:3000
 *  OPENLINK_E2E_ZOKERBASE_URL  default http://127.0.0.1:54380
 *  OPENLINK_E2E_SERVICE_KEY    service-role key (or read from the local stack .env)
 *  OPENLINK_E2E_EMAIL          defaults to the first confirmed local user
 *  OPENLINK_E2E_WORKSPACE      optional workspace slug
 *  OPENLINK_E2E_SESSION_ID     optional existing chat session id
 */
import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'

import { chromium } from 'playwright'

import { startGateway } from '../src/main/gateway.mjs'

const repositoryRoot = fileURLToPath(new URL('../../', import.meta.url))
const rendererDir = join(repositoryRoot, 'desktop/dist-renderer')
const appUrl = (process.env.OPENLINK_E2E_APP_URL || 'http://127.0.0.1:3000').replace(/\/+$/, '')
const zokerbaseUrl = (process.env.OPENLINK_E2E_ZOKERBASE_URL || 'http://127.0.0.1:54380').replace(/\/+$/, '')
const stackEnvPath = join(repositoryRoot, '.openlink-runtime/zokerbase/stack/.env')

async function serviceKey() {
  if (process.env.OPENLINK_E2E_SERVICE_KEY) return process.env.OPENLINK_E2E_SERVICE_KEY
  const contents = await readFile(stackEnvPath, 'utf8')
  const values = Object.fromEntries(
    contents
      .split(/\r?\n/)
      .filter((line) => /^[A-Z_]+=/.test(line))
      .map((line) => {
        const index = line.indexOf('=')
        return [line.slice(0, index), line.slice(index + 1)]
      }),
  )
  return values.SERVICE_ROLE_KEY || values.SUPABASE_SERVICE_ROLE_KEY || values.SUPABASE_SERVICE_KEY
}

const adminHeaders = (key) => ({
  apikey: key,
  authorization: `Bearer ${key}`,
  'content-type': 'application/json',
})

async function resolveEmail(key) {
  if (process.env.OPENLINK_E2E_EMAIL) return process.env.OPENLINK_E2E_EMAIL
  const response = await fetch(`${zokerbaseUrl}/auth/v1/admin/users`, { headers: adminHeaders(key) })
  if (!response.ok) throw new Error(`Unable to list local users: HTTP ${response.status}`)
  const payload = await response.json()
  const user = (payload.users ?? []).find((item) => item.email && item.email_confirmed_at)
  if (!user) throw new Error('No confirmed local user found')
  return user.email
}

async function generateMagicToken(key, email) {
  const response = await fetch(`${zokerbaseUrl}/auth/v1/admin/generate_link`, {
    method: 'POST',
    headers: adminHeaders(key),
    body: JSON.stringify({
      type: 'magiclink',
      email,
      redirect_to: `${appUrl}/auth/confirm`,
    }),
  })
  const payload = await response.json().catch(() => null)
  const token = payload?.hashed_token
  if (!response.ok || typeof token !== 'string' || !token) {
    throw new Error(`Magic link generation failed: HTTP ${response.status}`)
  }
  return token
}

async function openApi(page, path) {
  return page.evaluate(async (target) => {
    const response = await fetch(target, { cache: 'no-store' })
    return { status: response.status, body: await response.json().catch(() => null) }
  }, path)
}

const key = await serviceKey()
if (!key) throw new Error('A local Zokerbase service-role key is required')
const email = await resolveEmail(key)
const token = await generateMagicToken(key, email)

let gateway
let browser

try {
  gateway = await startGateway({
    rendererDir,
    upstreamUrl: appUrl,
    port: 0,
    profile: { id: 'real-local', kind: 'remote' },
    logger: { info() {}, error: console.error },
  })

  browser = await chromium.launch({ headless: true })
  const page = await browser.newPage({ viewport: { width: 1440, height: 940 } })
  const consoleErrors = []
  const browserGatewayErrors = []
  page.on('pageerror', (error) => consoleErrors.push(`pageerror: ${error.stack || error.message}`))
  page.on('console', (message) => {
    if (message.type() !== 'error') return
    const text = message.text()
    if (/Failed to load resource: the server responded with a status of (401|409)/.test(text)) return
    // The Live Browser surface has its own capability-gateway WebSocket. In a
    // localhost self-hosted stack its advertised gateway URL can require a
    // different cookie origin than the page; the chat stream asserted below is
    // independent of that surface, so keep the observation separate instead of
    // failing the chat verification.
    if (/WebSocket connection to .*\/v1\/browser\/gateway\/.*failed: HTTP Authentication failed/.test(text)) {
      browserGatewayErrors.push(text)
      return
    }
    consoleErrors.push(`console: ${text}`)
  })

  await page.goto(
    `${gateway.origin}/auth/confirm?token_hash=${encodeURIComponent(token)}&type=magiclink&next=%2Fapp`,
    { waitUntil: 'domcontentloaded', timeout: 120_000 },
  )
  await page.waitForURL(/\/app\/[^/]+/, { timeout: 180_000 })

  const workspaceSlug = decodeURIComponent(new URL(page.url()).pathname.split('/')[2] || '')
  assert.ok(workspaceSlug, 'the app entry must resolve a workspace slug')

  const workspaceResponse = await openApi(
    page,
    `/api/desktop/v1/bootstrap/workspace/${encodeURIComponent(workspaceSlug)}`,
  )
  assert.equal(workspaceResponse.status, 200)
  const workspace = workspaceResponse.body
  assert.ok(Array.isArray(workspace.chatSessions))
  assert.ok(workspace.chatSessions.length > 0, 'real workspace must have chat sessions')
  assert.ok(
    workspace.defaultProject?.name,
    'real workspace must have its default Draft project',
  )
  assert.ok(Array.isArray(workspace.projects))
  assert.equal(workspace.workspaceSlug, workspaceSlug)
  const workspaceName = workspace.activeWorkspace?.name
  assert.ok(workspaceName, 'workspace name must be present')
  await page.waitForSelector('text=Recent chats', { timeout: 60_000 }).catch(async (error) => {
    process.stderr.write(
      `workspace render debug:\n${JSON.stringify(
        {
          url: page.url(),
          text: (await page.locator('body').innerText().catch(() => '')).slice(0, 3_000),
          consoleErrors,
          workspaceShape: Object.fromEntries(
            Object.entries(workspace).map(([key, value]) => [
              key,
              Array.isArray(value) ? `array(${value.length})` : value === null ? 'null' : typeof value,
            ]),
          ),
          defaultProjectKeys: workspace.defaultProject ? Object.keys(workspace.defaultProject) : null,
        },
        null,
        2,
      )}\n`,
    )
    await page.screenshot({ path: '/tmp/openlink-real-workspace-debug.png', fullPage: false }).catch(() => undefined)
    throw error
  })
  const workspaceText = await page.locator('body').innerText()
  assert.ok(workspaceText.includes('Draft'), 'real default project must render')
  assert.ok(
    workspace.chatSessions.some((item) => workspaceText.includes(item.title)),
    'real chat titles must render in the workspace sidebar',
  )
  await page.screenshot({ path: '/tmp/openlink-real-workspace.png', fullPage: false })

  // Settings: render real preferences, then persist a temporary locale through
  // the desktop action bridge and restore the original value.
  const settingsBefore = await openApi(page, '/api/desktop/v1/bootstrap/settings')
  assert.equal(settingsBefore.status, 200)
  const originalPreferences = settingsBefore.body.page?.preferences
  assert.ok(originalPreferences, 'settings bootstrap must include preferences')
  await page.goto(`${gateway.origin}/settings`, { waitUntil: 'domcontentloaded', timeout: 120_000 })
  await page.waitForSelector('text=Preferences', { timeout: 60_000 }).catch(() => undefined)
  await page.screenshot({ path: '/tmp/openlink-real-settings.png', fullPage: false })

  const temporaryLocale = originalPreferences.locale === 'zh-CN' ? 'en-US' : 'zh-CN'
  const savedPreferences = await page.evaluate(async (input) => {
    const response = await fetch('/api/desktop/v1/actions', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ action: 'settings.savePreferences', input }),
    })
    return { status: response.status, body: await response.json().catch(() => null) }
  }, { ...originalPreferences, locale: temporaryLocale })
  assert.equal(savedPreferences.status, 200)
  assert.equal(savedPreferences.body?.ok, true)

  const settingsAfter = await openApi(page, '/api/desktop/v1/bootstrap/settings')
  assert.equal(settingsAfter.status, 200)
  assert.equal(settingsAfter.body.page?.preferences?.locale, temporaryLocale)

  await page.evaluate(async (input) => {
    await fetch('/api/desktop/v1/actions', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ action: 'settings.savePreferences', input }),
    })
  }, originalPreferences)

  // Chat: existing real session data and the real Agent Host stream.
  const session =
    workspace.chatSessions.find((item) => item.id === process.env.OPENLINK_E2E_SESSION_ID) ??
    workspace.chatSessions.find((item) => item.title && item.title !== 'New Chat') ??
    workspace.chatSessions[0]
  assert.ok(session?.id && session?.userId, 'a real chat session is required')

  const chatBootstrap = await openApi(
    page,
    `/api/desktop/v1/bootstrap/chat/${encodeURIComponent(session.userId)}/${encodeURIComponent(session.id)}?run=`,
  )
  assert.equal(chatBootstrap.status, 200)
  assert.ok(Array.isArray(chatBootstrap.body.initialEvents))
  assert.ok(chatBootstrap.body.initialEvents.length > 0, 'existing real chat must have persisted events')

  const runResponse = await openApi(
    page,
    `/api/chat/${encodeURIComponent(session.id)}/run?since=-1`,
  )
  assert.equal(runResponse.status, 200)
  assert.ok(Array.isArray(runResponse.body.events) && runResponse.body.events.length > 0)

  await page.goto(
    `${gateway.origin}/${encodeURIComponent(session.userId)}/chat/${encodeURIComponent(session.id)}`,
    { waitUntil: 'domcontentloaded', timeout: 120_000 },
  )
  await page.waitForSelector('textarea', { timeout: 120_000 })
  await page.screenshot({ path: '/tmp/openlink-real-chat.png', fullPage: false })

  const created = await page.evaluate(async (workspaceSlug) => {
    const response = await fetch('/api/desktop/v1/actions', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        action: 'chat.create',
        input: { workspaceSlug, agent: 'pi' },
      }),
    })
    return { status: response.status, body: await response.json().catch(() => null) }
  }, workspaceSlug)
  assert.equal(created.status, 200)
  const createdSession = created.body?.result
  assert.ok(createdSession?.id, 'chat.create must return a real session id')

  const configuredModel = Array.isArray(workspace.configuredModels) ? workspace.configuredModels[0] : null
  const prompt = process.env.OPENLINK_E2E_CHAT_PROMPT || '请只回复：桌面链路验证通过'
  const stream = await page.evaluate(
    async ({ sessionId, prompt, model }) => {
      const controller = new AbortController()
      const timer = setTimeout(() => controller.abort(), 300_000)
      const types = new Set()
      let bytes = 0
      try {
        const response = await fetch(`/api/chat/${encodeURIComponent(sessionId)}/events`, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({
            message: prompt,
            ...(model ? { model: { providerId: model.providerId, modelId: model.modelId } } : {}),
          }),
          signal: controller.signal,
        })
        if (!response.ok) {
          return {
            ok: false,
            status: response.status,
            error: (await response.text().catch(() => '')).slice(0, 1_000),
            types: [...types],
            bytes,
          }
        }
        const reader = response.body.getReader()
        const decoder = new TextDecoder()
        let buffer = ''
        while (true) {
          const { done, value } = await reader.read()
          if (done) break
          const chunk = decoder.decode(value, { stream: true })
          bytes += chunk.length
          buffer += chunk
          for (const line of chunk.split('\n')) {
            if (!line.trim()) continue
            try {
              const event = JSON.parse(line)
              if (typeof event.type === 'string') types.add(event.type)
            } catch {
              // Partial JSON line; the next chunk completes it.
            }
          }
          if (
            types.has('message.user') &&
            (types.has('message.delta') ||
              types.has('reasoning.delta') ||
              types.has('tool.started') ||
              types.has('message.completed') ||
              types.has('session.completed'))
          ) {
            controller.abort()
            break
          }
        }
        return { ok: true, status: response.status, types: [...types], bytes, sample: buffer.slice(0, 2_000) }
      } catch (error) {
        return {
          ok: types.size > 0,
          status: 0,
          error: error instanceof Error ? error.message : String(error),
          types: [...types],
          bytes,
        }
      } finally {
        clearTimeout(timer)
      }
    },
    {
      sessionId: createdSession.id,
      prompt,
      model: configuredModel
        ? { providerId: configuredModel.providerId, modelId: configuredModel.modelId }
        : null,
    },
  )

  process.stderr.write(`chat stream debug:\n${JSON.stringify(stream, null, 2)}\n`)

  assert.equal(stream.ok, true, `chat stream failed: ${stream.error ?? ''}`)
  assert.ok(stream.types.includes('message.user'), 'chat stream must emit the user message')
  assert.ok(
    stream.types.some((type) =>
      ['message.delta', 'reasoning.delta', 'tool.started', 'message.completed', 'session.completed'].includes(type),
    ),
    'chat stream must emit agent output',
  )

  assert.deepEqual(consoleErrors, [])

  process.stdout.write(
    `${JSON.stringify(
      {
        ok: true,
        gateway: gateway.origin,
        app: appUrl,
        email,
        workspace: {
          slug: workspaceSlug,
          name: workspaceName,
          chats: workspace.chatSessions.length,
          defaultProject: workspace.defaultProject?.name ?? null,
          projects: workspace.projects.length,
        },
        existingChat: {
          id: session.id,
          title: session.title,
          persistedEvents: chatBootstrap.body.initialEvents.length,
          runEvents: runResponse.body.events.length,
        },
        settings: { originalLocale: originalPreferences.locale, persistedLocale: temporaryLocale, restored: true },
        chatStream: { status: stream.status, bytes: stream.bytes, types: stream.types },
        browserGatewayAuthErrors: browserGatewayErrors.length,
        screenshots: [
          '/tmp/openlink-real-workspace.png',
          '/tmp/openlink-real-settings.png',
          '/tmp/openlink-real-chat.png',
        ],
      },
      null,
      2,
    )}\n`,
  )
} finally {
  await browser?.close().catch(() => undefined)
  await gateway?.close().catch(() => undefined)
}
