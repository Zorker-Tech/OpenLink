import assert from "node:assert/strict"
import test from "node:test"

import { SelectedConsoleLog } from "../../source/adapters/interop/proto/generated/agent/v1/selected_context_pb.ts"
import { toConsoleLogPromptInputs } from "../../source/adapters/interop/agent/selected-console-logs-adapter.ts"

test("console log messages project only the fields the prompt displays", () => {
  assert.deepEqual(toConsoleLogPromptInputs([
    new SelectedConsoleLog({ message: "failed", timestamp: 17, level: "error", clientName: "browser", sessionId: "s1" }),
    new SelectedConsoleLog({ message: "ready", timestamp: 18, level: "info" }),
  ]), [
    { message: "failed", timestamp: 17, level: "error" },
    { message: "ready", timestamp: 18, level: "info" },
  ])
})
