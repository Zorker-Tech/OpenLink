import assert from "node:assert/strict";
import { describe, it } from "node:test";

import {
  smartModeMcpApprovalRequestRecordSchema,
  smartModeMcpApprovalStoreResource,
  smartModeMcpApprovalTtlMs,
} from "../../source/packages/agent/tools/mcp/smart-mode-approval-store.ts";

const validRecord = {
  id: "approval-1",
  conversationId: "conversation-1",
  createdAtMs: 1_800_000_000_000,
  fingerprint: "target-hash",
  blockReason: "write needs approval",
};

describe("pending MCP approval store contract", () => {
  it("accepts the owned record fields and drops unrelated properties", () => {
    const result = smartModeMcpApprovalRequestRecordSchema.parse({ ...validRecord, unused: "discard" });
    assert.deepEqual(result, validRecord);
  });

  it("requires a typed value for each stored field", () => {
    for (const field of Object.keys(validRecord)) {
      const candidate = { ...validRecord } as Record<string, unknown>;
      delete candidate[field];
      assert.equal(smartModeMcpApprovalRequestRecordSchema.safeParse(candidate).success, false, field);
    }
    for (const invalid of [
      { ...validRecord, id: 7 },
      { ...validRecord, conversationId: null },
      { ...validRecord, createdAtMs: "later" },
      { ...validRecord, fingerprint: false },
      { ...validRecord, blockReason: {} },
    ]) {
      assert.equal(smartModeMcpApprovalRequestRecordSchema.safeParse(invalid).success, false);
    }
  });

  it("keeps an approval answerable for one day", () => {
    assert.equal(smartModeMcpApprovalTtlMs, 24 * 60 * 60 * 1_000);
  });

  it("fails clearly when the session has no approval store", () => {
    assert.equal(typeof smartModeMcpApprovalStoreResource.symbol, "symbol");
    assert.throws(
      () => smartModeMcpApprovalStoreResource.remoteImplementation(undefined),
      /approval store is not configured/,
    );
  });
});
