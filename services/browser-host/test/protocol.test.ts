import test from 'node:test'
import assert from 'node:assert/strict'
import { BROWSER_PROTOCOL_VERSION, createPreviewElementLocator, isBrowserActionEnvelope, isBrowserSocketClientMessage } from '@openlink/browser-protocol'

test('protocol validator accepts bounded browser input and rejects malformed input', () => {
  const action = {
    version: BROWSER_PROTOCOL_VERSION,
    actionId: 'action-1',
    sessionId: 'session-1',
    actor: 'human',
    action: { type: 'element.click', pageId: 'page-1', x: 10, y: 20 },
  }
  assert.equal(isBrowserActionEnvelope(action), true)
  assert.equal(isBrowserSocketClientMessage({ type: 'action', payload: action }), true)
  assert.equal(isBrowserActionEnvelope({ ...action, actor: 'root' }), false)
  assert.equal(isBrowserActionEnvelope({ ...action, action: { type: 'viewport.set', viewport: { width: 1, height: 1, deviceScaleFactor: 99 } } }), false)
})

test('native Preview design and annotation actions validate their bounded inputs', () => {
  const base = { version: BROWSER_PROTOCOL_VERSION, actionId: 'preview-action', sessionId: 'session-1', actor: 'human' as const }
  for (const action of [
    { type: 'preview.styles.read', pageId: 'preview', ref: 'el-1' },
    { type: 'preview.layers.read', pageId: 'preview', rootRef: 'el-1' },
    { type: 'preview.style.set', pageId: 'preview', ref: 'el-1', property: 'background-color', value: 'rgb(1, 2, 3)' },
    { type: 'preview.style.reset', pageId: 'preview', ref: 'el-1', property: 'border-radius' },
    { type: 'preview.content.set', pageId: 'preview', ref: 'el-1', content: 'Updated heading' },
    { type: 'preview.content.reset', pageId: 'preview', ref: 'el-1' },
    { type: 'preview.theme.read', pageId: 'preview' },
    { type: 'preview.theme.set', pageId: 'preview', token: '--primary', value: 'oklch(0.6 0.2 30)' },
    { type: 'preview.theme.reset', pageId: 'preview', token: '--primary' },
    { type: 'preview.element.activate', pageId: 'preview', ref: 'el-1' },
    { type: 'preview.annotation.select', pageId: 'preview', x: 20, y: 30, width: 80, height: 50 },
    { type: 'preview.locator.resolve', pageId: 'preview', locator: { version: 1, tagName: 'button', candidates: [{ kind: 'data-testid', value: 'save' }] } },
  ]) assert.equal(isBrowserActionEnvelope({ ...base, action }), true, action.type)

  const locator = createPreviewElementLocator({
    tagName: 'button', selector: '#save', attributes: { id: 'save', 'data-testid': 'save' },
  })
  assert.deepEqual(locator, {
    version: 1,
    tagName: 'button',
    candidates: [{ kind: 'data-testid', value: 'save' }, { kind: 'id', value: 'save' }, { kind: 'css', value: '#save' }],
  })
  assert.equal(isBrowserActionEnvelope({ ...base, action: { type: 'preview.locator.resolve', pageId: 'preview', locator: { version: 1, tagName: 'button', candidates: [] } } }), false)

  assert.equal(isBrowserActionEnvelope({ ...base, action: { type: 'preview.style.set', pageId: 'preview', ref: 'el-1', property: 'background-color', value: 'x'.repeat(257) } }), false)
  assert.equal(isBrowserActionEnvelope({ ...base, action: { type: 'preview.content.set', pageId: 'preview', ref: 'el-1', content: 'x'.repeat(2001) } }), false)
  assert.equal(isBrowserActionEnvelope({ ...base, action: { type: 'preview.theme.set', pageId: 'preview', token: 'color', value: 'red' } }), false)
  assert.equal(isBrowserActionEnvelope({ ...base, action: { type: 'preview.annotation.select', pageId: 'preview', x: -1, y: 0 } }), false)
})
