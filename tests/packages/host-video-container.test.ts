import { test } from "node:test"
import assert from "node:assert/strict"

import { ASCII_MARKERS, BYTE_MARKERS, bytesLookLikeVideoContainer, hasAsciiAt } from "../../source/host/runner/video-container.ts"

/** Bytes that carry a text marker at an offset, with room around it. */
const withAsciiAt = (text: string, offset: number): Uint8Array => {
  const bytes = new Uint8Array(offset + text.length + 2)
  for (let index = 0; index < text.length; index += 1) bytes[offset + index] = text.charCodeAt(index)
  return bytes
}

test("the markers are the ones the common containers start with", () => {
  assert.deepEqual(ASCII_MARKERS.map(marker => [marker.offset, marker.text]), [[4, "ftyp"], [0, "OggS"], [0, "FLV"], [8, "AVI "]])
  assert.deepEqual(BYTE_MARKERS, [[26, 69, 223, 163], [48, 38, 178, 117], [0, 0, 1, 186], [0, 0, 1, 179]])
})

test("a file is a video container when its first bytes carry one of the markers", () => {
  for (const marker of ASCII_MARKERS) {
    assert.equal(bytesLookLikeVideoContainer(withAsciiAt(marker.text, marker.offset)), true, marker.text)
  }
  for (const marker of BYTE_MARKERS) {
    assert.equal(bytesLookLikeVideoContainer(new Uint8Array(marker)), true, marker.join(","))
  }

  assert.equal(bytesLookLikeVideoContainer(new Uint8Array()), false)
  assert.equal(bytesLookLikeVideoContainer(new Uint8Array([0, 0, 0, 0])), false)
  assert.equal(bytesLookLikeVideoContainer(withAsciiAt("ftyp", 0)), false, "the text marker only counts at its own offset")
  assert.equal(bytesLookLikeVideoContainer(withAsciiAt("AVI ", 0)), false)
  assert.equal(bytesLookLikeVideoContainer(withAsciiAt("OggS", 1)), false)
  assert.equal(bytesLookLikeVideoContainer(new Uint8Array([26, 69, 223])), false, "a truncated byte marker is not the marker")
  assert.equal(bytesLookLikeVideoContainer(new Uint8Array([26, 69, 223, 162])), false)
  assert.equal(bytesLookLikeVideoContainer([26, 69, 223, 163] as never), false, "only a Uint8Array carries a byteLength")
})

test("a text is looked for at an offset, and only when there is room for it", () => {
  const bytes = withAsciiAt("ftyp", 4)
  assert.equal(hasAsciiAt(bytes, 4, "ftyp"), true)
  assert.equal(hasAsciiAt(bytes, 0, "ftyp"), false)
  assert.equal(hasAsciiAt(bytes, 4, "fty"), true, "a shorter text is a prefix match")
  assert.equal(hasAsciiAt(bytes, 4, "ftypx"), false)
  const exact = new Uint8Array(4)
  for (let index = 0; index < 4; index += 1) exact[index] = "ftyp".charCodeAt(index)
  assert.equal(hasAsciiAt(exact, 0, "ftyp"), true, "a text that ends exactly at the end of the bytes is there")
  assert.equal(hasAsciiAt(new Uint8Array(3), 0, "ftyp"), false)
  assert.equal(hasAsciiAt(new Uint8Array(4), 0, "ftyp"), false)
  assert.equal(hasAsciiAt(new Uint8Array(0), 0, ""), true, "an empty text is always at an offset inside the bytes")
  assert.equal(hasAsciiAt(new Uint8Array(0), 1, ""), false)
})
