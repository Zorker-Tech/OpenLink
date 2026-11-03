import assert from 'node:assert/strict'
import test from 'node:test'
import { previewUpstreamPath } from '../src/preview-proxy.js'

const publicPath = '/v1/browser/sessions/session-1/preview'

test('preview requests keep the authenticated Project proxy base path', () => {
  assert.equal(
    previewUpstreamPath({
      publicPath,
      targetPath: '/v1/sandboxes/sandbox-1/proxy/5173/',
      pathMode: 'strip-session-prefix',
      url: new URL(`http://preview.local${publicPath}/assets/app.js?v=1`),
    }),
    '/v1/sandboxes/sandbox-1/proxy/5173/assets/app.js?v=1',
  )
})

test('a direct loopback target keeps its root path', () => {
  assert.equal(
    previewUpstreamPath({
      publicPath,
      targetPath: '/',
      pathMode: 'strip-session-prefix',
      url: new URL(`http://preview.local${publicPath}/`),
    }),
    '/',
  )
})

test('preserve-session-prefix forwards the full public path under the target base', () => {
  assert.equal(
    previewUpstreamPath({
      publicPath,
      targetPath: '/base/',
      pathMode: 'preserve-session-prefix',
      url: new URL(`http://preview.local${publicPath}/dashboard`),
    }),
    `/base${publicPath}/dashboard`,
  )
})

test('paths outside the session preview prefix are rejected', () => {
  assert.throws(() => previewUpstreamPath({
    publicPath,
    targetPath: '/',
    pathMode: 'strip-session-prefix',
    url: new URL('http://preview.local/other/'),
  }), /outside the session/)
})
