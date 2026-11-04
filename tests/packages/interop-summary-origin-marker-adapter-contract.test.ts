import assert from "node:assert/strict";
import { test } from "node:test";

import {
  hasCounterpartSummaryOrigin,
  readCounterpartMessageTraceIds,
} from "../../source/adapters/interop/cursor-backend/summary-origin-marker-adapter.ts";

test("counterpart summary metadata is recognized only at its exact marker path", () => {
  assert.equal(hasCounterpartSummaryOrigin({ role: "user", providerOptions: { cursor: { isSummary: true } } }), true);
  assert.equal(hasCounterpartSummaryOrigin({ role: "user", providerOptions: { cursor: { isSummary: false } } }), false);
  assert.equal(hasCounterpartSummaryOrigin({ role: "user", providerOptions: { other: { isSummary: true } } }), false);
  assert.equal(hasCounterpartSummaryOrigin({ role: "user", providerOptions: "summary" }), false);
  assert.equal(hasCounterpartSummaryOrigin(null), false);
  assert.deepEqual(readCounterpartMessageTraceIds({
    providerOptions: { cursor: { messageId: "message-a", requestId: "request-a" } },
  }), { messageId: "message-a", requestId: "request-a" });
  assert.deepEqual(readCounterpartMessageTraceIds({
    providerOptions: { cursor: { messageId: 7, requestId: "request-b" } },
  }), { requestId: "request-b" });
});
