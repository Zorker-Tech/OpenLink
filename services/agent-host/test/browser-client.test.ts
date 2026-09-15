import test from 'node:test'
import assert from 'node:assert/strict'
import { BrowserHostClient } from '../src/browser-client.js'

test('browser client creates a scoped session and performs agent actions', async () => {
  const requests: Array<{ url: string; init?: RequestInit }> = []
  const fetchMock: typeof fetch = async (input, init) => {
    const url = String(input)
    requests.push({ url, init })
    if (url.endsWith('/v1/browser/sessions')) {
      return Response.json({
        session: {
          version: 1, id: 'browser-1', ownerId: 'user-1', workspaceId: 'workspace-1', projectId: '2c51ca26-3cd0-4cb4-896d-2061de06098c', surface: 'chromium-stream', status: 'ready',
          createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(), expiresAt: new Date(Date.now() + 60_000).toISOString(),
          controlOwner: null, pages: [], viewport: { width: 1280, height: 800, deviceScaleFactor: 1 },
          capabilities: { nativeDom: false, screencast: true, componentInspection: true, downloads: true, uploads: true, dialogs: true, devtools: true },
        },
        connection: {
          eventsUrl: 'ws://127.0.0.1:52002/v1/browser/sessions/browser-1/events?token=test',
          previewUrl: 'http://127.0.0.1:52002/v1/browser/sessions/browser-1/preview/?token=test',
          controlToken: 'scoped-control-token',
        },
      }, { status: 201 })
    }
    return Response.json({ result: { version: 1, actionId: 'action-1', sessionId: 'browser-1', ok: true, snapshot: '{}' } })
  }
  const client = new BrowserHostClient({ baseUrl: 'http://127.0.0.1:54322', serviceToken: 'service-token', fetch: fetchMock })
  const session = await client.createChromiumSession({ ownerId: 'user-1', workspaceId: 'workspace-1', projectId: '2c51ca26-3cd0-4cb4-896d-2061de06098c' })
  assert.equal(session.connection.eventsUrl, 'ws://127.0.0.1:54322/v1/browser/sessions/browser-1/events?token=test')
  assert.equal(session.connection.previewUrl, 'http://127.0.0.1:54322/v1/browser/sessions/browser-1/preview/?token=test')
  const result = await client.perform(session, { type: 'page.open', url: 'https://example.com' })
  assert.equal(result.ok, true)
  assert.equal((requests[0].init?.headers as Record<string, string>).Authorization, 'Bearer service-token')
  assert.equal((requests[1].init?.headers as Record<string, string>).Authorization, 'Bearer scoped-control-token')
})
