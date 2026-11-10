import assert from "node:assert/strict"
import { test } from "node:test"

import {
  CsnapsProtocolError,
  parseCsnapsResponse,
} from "../../source/host/extensions/codebase-telemetry/csnaps-protocol.ts"

test("a framed response with invalid UTF-8 is rejected instead of repaired", () => {
  const payload = Buffer.from('{"id":0,"ok":true,"result":"x"}')
  const contentByte = payload.indexOf("x")
  assert.notEqual(contentByte, -1)
  payload[contentByte] = 0xff

  assert.throws(
    () => parseCsnapsResponse(payload),
    (error: unknown) => error instanceof CsnapsProtocolError && error.message === "invalid csnaps response UTF-8",
  )
})
