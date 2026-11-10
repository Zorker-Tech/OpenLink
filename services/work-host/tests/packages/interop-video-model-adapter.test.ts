import assert from "node:assert/strict"
import { test } from "node:test"

import { isVideoAttachmentModelId } from "../../source/adapters/interop/inference/video-model-adapter.ts"

test("provider model identifiers map to the host's video attachment capability", () => {
  assert.equal(isVideoAttachmentModelId("gemini-3-pro"), true)
  assert.equal(isVideoAttachmentModelId("GEMINI-flash"), true)
  assert.equal(isVideoAttachmentModelId("gpt-5"), false)
  assert.equal(isVideoAttachmentModelId(undefined), false)
})
