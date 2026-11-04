import assert from "node:assert/strict"
import test from "node:test"

import {
  ATTACHMENT_BYTE_LIMIT,
  AttachmentTooLargeError,
  attachmentByteLimitForName,
  formatAttachmentTooLargeNotice,
  formatMegabytes,
  nameLooksLikeVideo,
  VIDEO_BYTE_LIMIT,
} from "../../source/shared/media/attachment-limits.ts"

test("video classification comes from the final path extension, without case sensitivity", () => {
  assert.equal(nameLooksLikeVideo("/workspace/capture.MOV"), true)
  assert.equal(nameLooksLikeVideo("folder.with.dots/clip.webm"), true)
  assert.equal(nameLooksLikeVideo("clip.mp4.bak"), false)
  assert.equal(nameLooksLikeVideo(".mov"), false)
  assert.equal(nameLooksLikeVideo("photo.png"), false)
  assert.equal(attachmentByteLimitForName("capture.MOV"), VIDEO_BYTE_LIMIT)
  assert.equal(attachmentByteLimitForName("photo.png"), ATTACHMENT_BYTE_LIMIT)
})

test("megabytes round to the nearest whole unit and notices identify the selected cap", () => {
  assert.equal(formatMegabytes(0), "0 MB")
  assert.equal(formatMegabytes(512 * 1024), "1 MB")
  assert.equal(formatMegabytes(1.5 * 1024 * 1024), "2 MB")
  assert.equal(
    formatAttachmentTooLargeNotice("capture.mp4"),
    '"capture.mp4" is too large to attach (max 200 MB for video).',
  )
  assert.equal(
    formatAttachmentTooLargeNotice("photo.png"),
    '"photo.png" is too large to attach (max 25 MB).',
  )
})

test("size errors retain the refused byte limit and a stable error identity", () => {
  const error = new AttachmentTooLargeError(ATTACHMENT_BYTE_LIMIT)
  assert.equal(error.name, "AttachmentTooLargeError")
  assert.equal(error.limitBytes, ATTACHMENT_BYTE_LIMIT)
  assert.equal(error.message, `Attachment exceeds ${ATTACHMENT_BYTE_LIMIT} bytes.`)
})
