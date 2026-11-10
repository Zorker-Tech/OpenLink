import assert from "node:assert/strict"
import { test } from "node:test"

import { DEFAULT_SHELL_FOREGROUND_TIMEOUT_MS, resolveShellTimeoutMs } from "../../source/packages/local-exec/shell-timeout.ts"

test("an explicit nonzero timeout takes precedence over background and hard-timeout settings", () => {
  assert.equal(resolveShellTimeoutMs({ timeout: 5_000, isBackground: false }), 5_000)
  assert.equal(resolveShellTimeoutMs({ timeout: 5_000, isBackground: true, hardTimeout: 1_000 }), 5_000)
})

test("zero means no foreground timeout only when another stop condition exists", () => {
  assert.equal(resolveShellTimeoutMs({ timeout: 0, isBackground: true }), 0)
  assert.equal(resolveShellTimeoutMs({ timeout: 0, isBackground: false, timeoutBehavior: "background" }), 0)
  assert.equal(resolveShellTimeoutMs({ timeout: 0, isBackground: false, hardTimeout: 1 }), 0)
})

test("foreground zero falls back unless its independent hard timeout is positive", () => {
  assert.equal(resolveShellTimeoutMs({ timeout: 0, isBackground: false }), DEFAULT_SHELL_FOREGROUND_TIMEOUT_MS)
  assert.equal(resolveShellTimeoutMs({ timeout: 0, isBackground: false, timeoutBehavior: "foreground" }), DEFAULT_SHELL_FOREGROUND_TIMEOUT_MS)
  assert.equal(resolveShellTimeoutMs({ timeout: 0, isBackground: false, hardTimeout: 0 }), DEFAULT_SHELL_FOREGROUND_TIMEOUT_MS)
  assert.equal(resolveShellTimeoutMs({ timeout: 0, isBackground: false, hardTimeout: -1 }), DEFAULT_SHELL_FOREGROUND_TIMEOUT_MS)
})
