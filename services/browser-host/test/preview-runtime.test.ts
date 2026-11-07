import assert from 'node:assert/strict'
import test from 'node:test'
import { BROWSER_PROTOCOL_VERSION, type BrowserActionEnvelope, type BrowserActionResult } from '@openlink/browser-protocol'
import { NativePreviewRuntime } from '../src/preview-runtime.js'
import type { BrowserSessionRuntimeContext } from '../src/session-manager.js'

test('native Preview relays design actions through the inspector bridge', async () => {
  const emitted: Array<Record<string, unknown>> = []
  let state = {
    version: BROWSER_PROTOCOL_VERSION,
    id: 'session-1',
    ownerId: 'user-1',
    workspaceId: 'workspace-1',
    projectId: '2c51ca26-3cd0-4cb4-896d-2061de06098c',
    surface: 'native-preview' as const,
    status: 'starting' as const,
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    expiresAt: new Date(Date.now() + 60_000).toISOString(),
    controlOwner: null,
    pages: [],
    viewport: { width: 1280, height: 800, deviceScaleFactor: 1 },
    capabilities: { nativeDom: true, screencast: false, componentInspection: true, downloads: true, uploads: true, dialogs: false, devtools: false },
  }
  const context = {
    sessionId: 'session-1',
    getState: () => state,
    update: (mutate: (current: typeof state) => typeof state) => { state = mutate(state) },
    emit: (event: Record<string, unknown>) => { emitted.push(event) },
  } as unknown as BrowserSessionRuntimeContext
  const runtime = new NativePreviewRuntime(context, {
    targetUrl: 'http://127.0.0.1:3001/',
    publicBaseUrl: 'http://127.0.0.1:43120',
    parentOrigins: ['http://localhost:3000'],
  })
  await runtime.start()

  const envelope: BrowserActionEnvelope = {
    version: BROWSER_PROTOCOL_VERSION,
    actionId: 'style-1',
    sessionId: 'session-1',
    actor: 'human',
    action: { type: 'preview.style.set', pageId: 'preview', ref: 'el-1', property: 'color', value: 'red' },
  }
  const resultPromise = runtime.perform(envelope)
  const command = emitted[0] as { type: string; commandId: string; action: BrowserActionEnvelope }
  assert.equal(command.type, 'bridge.command')
  assert.equal(command.action.action.type, 'preview.style.set')

  const result: BrowserActionResult = {
    version: BROWSER_PROTOCOL_VERSION,
    actionId: envelope.actionId,
    sessionId: envelope.sessionId,
    ok: true,
    snapshot: JSON.stringify({ styles: { color: 'red' } }),
  }
  runtime.resolveBridgeResult(command.commandId, result)
  assert.deepEqual(await resultPromise, result)
  await runtime.close()
})

test('native Preview keeps Chromium-only screenshots unavailable', async () => {
  const state = {
    version: BROWSER_PROTOCOL_VERSION,
    id: 'session-2',
    ownerId: 'user-1',
    workspaceId: 'workspace-1',
    projectId: '2c51ca26-3cd0-4cb4-896d-2061de06098c',
    surface: 'native-preview' as const,
    status: 'starting' as const,
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    expiresAt: new Date(Date.now() + 60_000).toISOString(),
    controlOwner: null,
    pages: [],
    viewport: { width: 1280, height: 800, deviceScaleFactor: 1 },
    capabilities: { nativeDom: true, screencast: false, componentInspection: true, downloads: true, uploads: true, dialogs: false, devtools: false },
  }
  const context = {
    sessionId: 'session-2',
    getState: () => state,
    update: () => undefined,
    emit: () => undefined,
  } as unknown as BrowserSessionRuntimeContext
  const runtime = new NativePreviewRuntime(context, {
    targetUrl: 'http://127.0.0.1:3001/',
    publicBaseUrl: 'http://127.0.0.1:43120',
    parentOrigins: ['http://localhost:3000'],
  })
  await assert.rejects(() => runtime.perform({
    version: BROWSER_PROTOCOL_VERSION,
    actionId: 'screenshot-1',
    sessionId: 'session-2',
    actor: 'human',
    action: { type: 'page.screenshot', pageId: 'preview' },
  }), (error: unknown) => error instanceof Error && 'code' in error && error.code === 'ACTION_REQUIRES_CHROMIUM')
  await runtime.close()
})
