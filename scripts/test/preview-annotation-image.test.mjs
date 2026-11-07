import assert from 'node:assert/strict'
import test from 'node:test'
import {
  decodePreviewAnnotationImage,
  isPreviewAnnotationObjectPath,
  PREVIEW_ANNOTATION_IMAGE_MAX_BYTES,
  previewAnnotationImageDataUrl,
  previewAnnotationObjectPath,
} from '../../lib/preview-annotation-image.server.mjs'

const projectId = '11111111-2222-4333-8444-555555555555'
const userId = 'aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee'
const annotationId = '99999999-8888-4777-8666-555555555555'
const jpeg = Buffer.from([0xff, 0xd8, 0xff, 0x00, 0xff, 0xd9])
const dataUrl = `data:image/jpeg;base64,${jpeg.toString('base64')}`

test('accepts canonical JPEG data URLs and round-trips stored bytes', () => {
  assert.deepEqual(decodePreviewAnnotationImage(dataUrl), jpeg)
  assert.equal(previewAnnotationImageDataUrl(jpeg), dataUrl)
})

test('rejects MIME mismatches, malformed base64, and non-JPEG payloads', () => {
  assert.equal(decodePreviewAnnotationImage(`data:image/png;base64,${jpeg.toString('base64')}`), null)
  assert.equal(decodePreviewAnnotationImage('data:image/jpeg;base64,@@@'), null)
  assert.equal(decodePreviewAnnotationImage(`data:image/jpeg;base64,${Buffer.from('not jpeg').toString('base64')}`), null)
  assert.equal(decodePreviewAnnotationImage(`data:image/jpeg;base64,${Buffer.from([0xff, 0xd8, 0xff, 0]).toString('base64')}`), null)
})

test('rejects images beyond the configured object and request limit', () => {
  const tooLarge = Buffer.alloc(PREVIEW_ANNOTATION_IMAGE_MAX_BYTES + 1)
  tooLarge.set([0xff, 0xd8, 0xff], 0)
  tooLarge.set([0xff, 0xd9], tooLarge.length - 2)
  assert.equal(previewAnnotationImageDataUrl(tooLarge), null)
  assert.equal(decodePreviewAnnotationImage(`data:image/jpeg;base64,${tooLarge.toString('base64')}`), null)
})

test('builds immutable project and user scoped object paths', () => {
  const path = previewAnnotationObjectPath(projectId.toUpperCase(), userId.toUpperCase(), annotationId.toUpperCase(), jpeg)
  assert.match(path, new RegExp(`^${projectId}/${userId}/${annotationId}-[a-f0-9]{64}[.]jpg$`))
  assert.equal(isPreviewAnnotationObjectPath(path, projectId), true)
  assert.equal(isPreviewAnnotationObjectPath(path, '22222222-3333-4444-8555-666666666666'), false)
  assert.equal(isPreviewAnnotationObjectPath(`${path}/../other.jpg`, projectId), false)
})
