import assert from "node:assert/strict"
import { test } from "node:test"

import {
  boundPreviewImageDataUrl,
  decodeBase64DataUrl,
  LINK_PREVIEW_MAX_DECODE_PIXELS,
  readEncodedImageSize,
  readIcoSize,
} from "../../source/host/attachments/link-preview-image-bounds.ts"

function pngDataUrl(width: number, height: number): string {
  const bytes = Buffer.alloc(24)
  bytes.set([137, 80, 78, 71, 13, 10, 26, 10])
  bytes.write("IHDR", 12, "ascii")
  bytes.writeUInt32BE(width, 16)
  bytes.writeUInt32BE(height, 20)
  return `data:image/png;base64,${bytes.toString("base64")}`
}

function icoWithSizes(sizes: readonly [number, number][]): Buffer {
  const bytes = Buffer.alloc(6 + sizes.length * 16)
  bytes.writeUInt16LE(1, 2)
  bytes.writeUInt16LE(sizes.length, 4)
  sizes.forEach(([width, height], index) => {
    const entry = 6 + index * 16
    bytes[entry] = width === 256 ? 0 : width
    bytes[entry + 1] = height === 256 ? 0 : height
  })
  return bytes
}

test("data URL decoding requires a base64 data header and returns its encoded bytes", () => {
  const source = pngDataUrl(12, 7)
  assert.deepEqual(decodeBase64DataUrl(source), Buffer.from(source.slice(source.indexOf(",") + 1), "base64"))
  assert.equal(decodeBase64DataUrl("https://files.invalid/image.png"), null)
  assert.equal(decodeBase64DataUrl("data:image/png,image-data"), null)
  assert.equal(decodeBase64DataUrl("data:image/png;base64"), null)
})

test("encoded dimensions come from recognized signatures and reject zero or unreadable sizes", () => {
  assert.deepEqual(readEncodedImageSize(pngDataUrl(400, 200)), { width: 400, height: 200 })
  assert.equal(readEncodedImageSize(pngDataUrl(0, 200)), null)
  assert.equal(readEncodedImageSize("data:image/png;base64,"), null)
})

test("ICO size selection uses the largest directory entry and the zero-as-256 convention", () => {
  assert.deepEqual(readIcoSize(icoWithSizes([[16, 16], [32, 48]])), { width: 32, height: 48 })
  assert.deepEqual(readIcoSize(icoWithSizes([[0, 0]])), { width: 256, height: 256 })
  assert.equal(readIcoSize(Buffer.from([0, 0, 1, 0, 1, 0])), null)
  assert.equal(readIcoSize(Buffer.alloc(10)), null)
})

test("preview bounds skip absent, unreadable and excessive images before resizing", () => {
  let calls = 0
  const resize = () => { calls += 1; return "resized" }
  const bounds = { maxDimension: 300, encoding: "webp" }

  assert.equal(boundPreviewImageDataUrl(null, bounds, resize), null)
  assert.equal(boundPreviewImageDataUrl("not-an-image", bounds, resize), null)
  assert.equal(boundPreviewImageDataUrl(pngDataUrl(6_001, 4_000), bounds, resize), null)
  assert.equal(calls, 0)
  assert.equal(LINK_PREVIEW_MAX_DECODE_PIXELS, 24_000_000)
})

test("only the oversized axis is sent to resize, and a failed resize retains the original", () => {
  const bounds = { maxDimension: 300, encoding: "webp" }
  const landscape = pngDataUrl(400, 200)
  let received: unknown
  assert.equal(boundPreviewImageDataUrl(landscape, bounds, (source, target, encoding) => {
    received = { source, target, encoding }
    return "landscape-resized"
  }), "landscape-resized")
  assert.deepEqual(received, { source: landscape, target: { width: 300 }, encoding: "webp" })

  const portrait = pngDataUrl(200, 400)
  assert.equal(boundPreviewImageDataUrl(portrait, bounds, (_source, target) => {
    assert.deepEqual(target, { height: 300 })
    return null
  }), portrait)
  const alreadySmall = pngDataUrl(250, 200)
  assert.equal(boundPreviewImageDataUrl(alreadySmall, bounds, () => assert.fail("a fitting image should not be resized")), alreadySmall)
})
