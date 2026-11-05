import assert from "node:assert/strict"
import test from "node:test"

import {
  computerUseSubagentDescription,
  isComputerUseSubagentType,
} from "../../source/host/runner/tools/slate-computer-use-subagent.ts"
import { createSlateComputerUseSubagentConfig } from "../../source/host/runner/tools/slate-computer-use-subagent.ts"

test("computer-use names are normalized, while unrelated types stay distinct", () => {
  assert.equal(isComputerUseSubagentType("computer_use"), true)
  assert.equal(isComputerUseSubagentType("Computer-Use"), true)
  assert.equal(isComputerUseSubagentType("COMPUTER USE"), true)
  assert.equal(isComputerUseSubagentType("browserUse"), false)
  assert.equal(isComputerUseSubagentType(undefined), false)
  assert.equal(isComputerUseSubagentType(null), false)
})

test("desktop guidance stays focused and reserves human-only steps for the user", () => {
  const description = computerUseSubagentDescription(false)
  assert.match(description, /desktop/i)
  assert.match(description, /background/i)
  assert.match(description, /follow-up/i)
  assert.match(description, /MessageSubagent/)
  assert.match(description, /StopSubagent/)
  assert.match(description, /one.*at a time/i)
  assert.match(description, /2FA|two-factor/i)
  assert.doesNotMatch(description, /browserUse/)
})

test("page automation is preferred for page-only work when it is available", () => {
  const description = computerUseSubagentDescription(true)
  assert.match(description, /browserUse/)
  assert.match(description, /page/i)
  assert.match(description, /desktop/i)
})

test("the built-in subagent config uses Slate's own kind value", () => {
  const config = createSlateComputerUseSubagentConfig({ browserUseOffered: false })
  assert.deepEqual(config.subagentType, { kind: "computer-use" })
  assert.equal(config.preserveTaskTool, false)
  assert.equal(config.subagentSource, "builtin")
  assert.match(config.description, /desktop/i)
})
