import { test } from "node:test"
import assert from "node:assert/strict"

import { SlateMode } from "../../source/packages/agent/mode-processing.ts"
import { RequestContext, RequestContextEnv } from "../../source/adapters/interop/proto/generated/agent/v1/request_context_exec_pb.ts"
import { toRedactedRequestContext } from "../../source/adapters/interop/redacted-protos/generated/agent/v1/request_context_exec_redacted.ts"
import { PrivacyMode } from "../../source/packages/redaction/privacy-mode.ts"
import { decodeIncomingRequestContext, shouldHideMcpMetaToolSnapshot } from "../../source/adapters/interop/agent/user-message-action-input-adapter.ts"

test("redacted resume context is decoded at the interop boundary", () => {
  const requestContext = new RequestContext({
    env: new RequestContextEnv({ osVersion: "Slate OS", workspacePaths: ["/workspace"] }),
  })
  const redacted = toRedactedRequestContext(requestContext, PrivacyMode.NO_TRAINING)
  const decoded = decodeIncomingRequestContext(redacted)

  assert.equal(decoded.env?.osVersion, "Slate OS")
  assert.deepEqual(decoded.env?.workspacePaths, ["/workspace"])
})

test("ask mode filters the dynamic-tool snapshot by default, but honors an explicit opt-out", () => {
  assert.equal(shouldHideMcpMetaToolSnapshot({
    mode: SlateMode.CHAT,
    enableFilterEditToolsInAskMode: undefined,
    modelInfo: undefined,
  }), true)
  assert.equal(shouldHideMcpMetaToolSnapshot({
    mode: SlateMode.CHAT,
    enableFilterEditToolsInAskMode: false,
    modelInfo: undefined,
  }), false)
  assert.equal(shouldHideMcpMetaToolSnapshot({
    mode: SlateMode.AGENT,
    enableFilterEditToolsInAskMode: true,
    modelInfo: undefined,
  }), false)
})

test("raw training variants of the designated model always filter the snapshot", () => {
  const modelInfo = { isComposerMatterhorn: true, isRawTrainingSlug: true }
  assert.equal(shouldHideMcpMetaToolSnapshot({
    mode: SlateMode.AGENT,
    enableFilterEditToolsInAskMode: false,
    modelInfo,
  }), true)
  assert.equal(shouldHideMcpMetaToolSnapshot({
    mode: SlateMode.AGENT,
    enableFilterEditToolsInAskMode: false,
    modelInfo: { ...modelInfo, isRawTrainingSlug: false },
  }), false)
})
