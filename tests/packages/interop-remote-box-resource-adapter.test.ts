import { test } from "node:test";
import assert from "node:assert/strict";

import {
  computerUseActionForAudit,
  shellCommandForAudit,
} from "../../source/adapters/interop/agent/remote-box-resource-adapter.ts";

test("box command and desktop action projections expose only audit details", () => {
  assert.equal(shellCommandForAudit({ command: "git status", toolCallId: "call-1" }), "git status");
  assert.equal(shellCommandForAudit({ command: 5 }), "");
  assert.equal(computerUseActionForAudit({
    actions: [{ kind: "click", coordinate: { x: 2, y: 3 }, button: "left", count: 1 }],
  }), "click");
  assert.equal(computerUseActionForAudit({ actions: [] }), undefined);
  assert.equal(computerUseActionForAudit({ actions: [{ action: { case: "click" } }] }), undefined);
});
