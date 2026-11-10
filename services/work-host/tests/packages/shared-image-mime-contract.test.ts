import assert from "node:assert/strict"
import test from "node:test"

import {
  audioMimeFromPath,
  extensionFromImageMime,
  imageMimeFromPath,
  servableImageMimeFromPath,
  videoMimeFromPath,
} from "../../source/shared/media/image-mime.ts"

test("media lookup uses the final extension and keeps native-client images separate", () => {
  assert.equal(imageMimeFromPath("/assets/Photo.JPEG"), "image/jpeg")
  assert.equal(imageMimeFromPath("/assets/diagram.svg"), "image/svg+xml")
  assert.equal(imageMimeFromPath("/assets/photo.heic"), undefined)
  assert.equal(servableImageMimeFromPath("/assets/photo.heic"), "image/heic")
  assert.equal(servableImageMimeFromPath("/assets/unknown.bin"), undefined)
})

test("video and audio extensions map independently, and reverse image lookup ignores MIME case", () => {
  assert.equal(videoMimeFromPath("capture.MOV"), "video/quicktime")
  assert.equal(audioMimeFromPath("voice.MP3"), "audio/mpeg")
  assert.equal(extensionFromImageMime("IMAGE/PNG"), ".png")
  assert.equal(extensionFromImageMime("video/mp4"), undefined)
})
