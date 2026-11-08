import assert from 'node:assert/strict'
import test from 'node:test'
import {
  createPreviewScreenshotReceipt,
  verifyPreviewScreenshotReceipt,
} from '../../lib/preview-screenshot-receipt.server.mjs'

const secret = 'test-secret-'.repeat(8)
const image = Buffer.from([0xff, 0xd8, 0xff, 0x00, 0xff, 0xd9])
const expected = {
  userId: 'aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee',
  projectId: '11111111-2222-4333-8444-555555555555',
  targetId: 'A'.repeat(43),
  pagePath: '/preview/home',
  viewport: { width: 1280, height: 720 },
  targetRevision: `git-sha256:${'a'.repeat(64)}`,
  image,
}

function issue(now = 1_800_000_000_000) {
  return createPreviewScreenshotReceipt({ secret, ...expected, now })
}

test('attests the exact user, project, target, page, viewport, revision and image', () => {
  const receipt = issue()
  assert.equal(typeof receipt, 'string')
  assert.equal(verifyPreviewScreenshotReceipt({ secret, receipt, expected, now: 1_800_000_010_000 }), true)
  for (const changed of [
    { ...expected, userId: 'bbbbbbbb-bbbb-4ccc-8ddd-eeeeeeeeeeee' },
    { ...expected, projectId: '22222222-2222-4333-8444-555555555555' },
    { ...expected, targetId: 'B'.repeat(43) },
    { ...expected, pagePath: '/preview/other' },
    { ...expected, viewport: { width: 1280, height: 800 } },
    { ...expected, targetRevision: `git-sha256:${'b'.repeat(64)}` },
    { ...expected, image: Buffer.from('another image') },
  ]) {
    assert.equal(verifyPreviewScreenshotReceipt({ secret, receipt, expected: changed, now: 1_800_000_010_000 }), false)
  }
})

test('rejects tampering, other secrets, expired receipts, and excessive clock skew', () => {
  const receipt = issue()
  assert.equal(verifyPreviewScreenshotReceipt({ secret: `${secret}wrong`, receipt, expected, now: 1_800_000_010_000 }), false)
  assert.equal(verifyPreviewScreenshotReceipt({ secret, receipt: `${receipt.slice(0, -1)}x`, expected, now: 1_800_000_010_000 }), false)
  assert.equal(verifyPreviewScreenshotReceipt({ secret, receipt, expected, now: 1_800_001_800_001 }), false)
  assert.equal(verifyPreviewScreenshotReceipt({ secret, receipt, expected, now: 1_799_999_900_000 }), false)
  assert.equal(verifyPreviewScreenshotReceipt({ secret: 'short', receipt, expected, now: 1_800_000_010_000 }), false)
})
