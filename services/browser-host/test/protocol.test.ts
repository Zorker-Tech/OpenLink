import test from 'node:test'
import assert from 'node:assert/strict'
import { BROWSER_PROTOCOL_VERSION, isBrowserActionEnvelope, isBrowserSocketClientMessage } from '@openlink/browser-protocol'

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
