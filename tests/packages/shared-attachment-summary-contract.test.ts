import assert from "node:assert/strict"
import { test } from "node:test"

import {
  classifyAttachment,
  classifyMimeType,
  classifyPathLike,
  countAttachmentKinds,
  extensionSubject,
} from "../../source/shared/media/attachment-summary.ts"

test("MIME classification removes parameters, ignores case and follows the recognized family table", () => {
  const cases: Array<[string, string | null]> = [
    [" IMAGE/PNG; charset=binary ", "image"],
    ["video/mp4; codecs=h264", "video"],
    ["audio/ogg", "audio"],
    ["application/pdf", "pdf"],
    ["text/markdown", "markdown"],
    ["text/csv", "table"],
    ["application/vnd.openxmlformats-officedocument.spreadsheetml.sheet", "table"],
    ["application/problem+json", "json"],
    ["application/msword", "document"],
    ["application/vnd.openxmlformats-officedocument.wordprocessingml.document", "document"],
    ["application/x-7z-compressed", "archive"],
    ["text/plain", "text"],
    ["application/octet-stream", null],
    ["", null],
  ]
  for (const [mimeType, expected] of cases) assert.equal(classifyMimeType(mimeType), expected, mimeType)
})

test("path classification decodes URL paths and recognizes preview, structured-text and archive suffixes", () => {
  assert.equal(extensionSubject("https://files.invalid/folder%20name/report.JSONC?download=1"), "/folder name/report.JSONC")
  assert.equal(extensionSubject("https://files.invalid/bad%ZZ.bin"), "/bad%ZZ.bin")
  assert.equal(extensionSubject("plain-name.bin"), "plain-name.bin")

  assert.equal(classifyPathLike("photo.png"), "image")
  assert.equal(classifyPathLike("https://files.invalid/report%20final.json5?download=1"), "json")
  assert.equal(classifyPathLike("events.ndjson"), "json")
  assert.equal(classifyPathLike("brief.docx"), "document")
  assert.equal(classifyPathLike("bundle.tar.gz"), "archive")
  assert.equal(classifyPathLike("payload.unknown"), null)
})

test("classification prefers a recognized MIME type, then the file name, then the supplied location", () => {
  assert.equal(classifyAttachment({ mimeType: "application/pdf", fileName: "image.png", urlOrPath: "movie.mp4" }), "pdf")
  assert.equal(classifyAttachment({ mimeType: "application/octet-stream", fileName: "image.png", urlOrPath: "movie.mp4" }), "image")
  assert.equal(classifyAttachment({ fileName: "payload.bin", urlOrPath: "movie.mp4" }), "video")
  assert.equal(classifyAttachment({ mimeType: "unknown/type", fileName: "payload.bin", urlOrPath: "payload.unknown" }), "file")
})

test("kind counts retain first-seen order and combine repeated kinds", () => {
  assert.deepEqual(countAttachmentKinds(["image", "file", "image", "archive", "file"]), [
    { kind: "image", count: 2 },
    { kind: "file", count: 2 },
    { kind: "archive", count: 1 },
  ])
})
