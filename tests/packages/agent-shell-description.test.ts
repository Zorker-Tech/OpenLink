import { test } from "node:test"
import assert from "node:assert/strict"
import { z } from "zod"

import {
  getShellToolDescription,
  getShellToolParametersSchema,
  notifyOnOutputSchema,
} from "../../source/packages/agent/tools/core/shell/shell-tool-description.ts"

const noSandbox = { sandboxEnabled: false }

// ---------------------------------------------------------------------------------------------
// the description per prompt version
// ---------------------------------------------------------------------------------------------

test("the earliest version is told to propose a command and to avoid newlines", () => {
  const description = getShellToolDescription(false, "something-else")
  assert.match(description, /^PROPOSE a command to run on behalf of the user/)
  assert.match(description, /Dont include any newlines in the command/)
})

test("a later version is told about quoting, terminals and the tools to prefer", () => {
  const description = getShellToolDescription(false, "dsv3-1205")
  assert.match(description, /^Executes a given command in a shell session with optional timeout/)
  assert.match(description, /Always quote file paths that contain spaces/)
  assert.match(description, /ALWAYS USE ripgrep at `rg`/)
  assert.doesNotMatch(description, /PROPOSE a command/)
})

test("the newest version says it waits for the block-until duration", () => {
  const description = getShellToolDescription(false, "cursor-0226")
  assert.match(description, /^Executes a given command in a shell session, waiting for output for `block_until_ms` millis\./)
})

test("a session that can background commands is told how to manage them", () => {
  const description = getShellToolDescription(false, "dsv3-1205", { enableBlockUntilMs: true, defaultBlockUntilMs: 45_000 })
  assert.match(description, /Managing long-running commands:/)
  assert.match(description, /\(default 45s\)/)
  assert.match(description, /Set `block_until_ms: 0` to immediately background/)
})

test("a required block-until duration is not described as having a default", () => {
  const description = getShellToolDescription(false, "dsv3-1205", { enableBlockUntilMs: true, requireBlockUntilMs: true })
  assert.match(description, /Commands that don't complete within `block_until_ms` are moved to background/)
  assert.doesNotMatch(description, /\(default /)
})

test("how to monitor a backgrounded command follows what the session can do", () => {
  const byFile = getShellToolDescription(false, "dsv3-1205", { enableBlockUntilMs: true })
  assert.match(byFile, /Monitoring backgrounded commands:/)
  assert.match(byFile, /exponential backoff is a good strategy/)

  const byNotification = getShellToolDescription(false, "dsv3-1205", {
    enableBlockUntilMs: true,
    awaitToolName: "Await",
    enableJobCompletionNotifications: true,
  })
  assert.match(byNotification, /You'll be notified when the backgrounded command completes/)
  assert.match(byNotification, /fire-and-forget commands/)

  const byAwait = getShellToolDescription(false, "dsv3-1205", { enableBlockUntilMs: true, awaitToolName: "Await" })
  assert.match(byAwait, /Use `Await` to monitor the background command\./)
})

test("the sections that only apply sometimes are added only then", () => {
  const plain = getShellToolDescription(false, "something-else")
  assert.doesNotMatch(plain, /instead of shell text processing/)

  const withReadTool = getShellToolDescription(false, "something-else", { readToolName: "read_file" })
  assert.match(withReadTool, /Use read_file for file reads and searches instead of shell text processing\./)

  const withTerminalFiles = getShellToolDescription(false, "something-else", { enableTerminalFiles: true })
  assert.match(withTerminalFiles, /Large output is saved to a terminal file/)

  const withTmux = getShellToolDescription(false, "something-else", { enableTmuxGuidance: true })
  assert.match(withTmux, /<tmux-backed-shell-sessions>/)

  const withSandbox = getShellToolDescription(true, "something-else", { isReadonly: true })
  assert.match(withSandbox, /readonly sandbox/)
})

test("the sandbox description is appended without the other sections for the newest version", () => {
  const description = getShellToolDescription(true, "cursor-0226", { isReadonly: true })
  assert.match(description, /readonly sandbox/)
  assert.match(description, /^Executes a given command in a shell session, waiting for output/)
})

test("a minimal harness gets its own short description", () => {
  const description = getShellToolDescription(true, "cursor-0226", {
    useMinimalHarness: true,
    isReadonly: true,
    readToolName: "read_file",
  })
  assert.match(description, /^Execute shell commands in the workspace\./)
  assert.match(description, /NEVER use `set -x`/)
  assert.match(description, /Use the 'Workspace Path' field/)
  assert.match(description, /Use read_file for file reads/)
  assert.doesNotMatch(description, /PROPOSE a command/)
})

test("the progress notification section appears only when notifications are on", () => {
  const without = getShellToolDescription(false, "dsv3-1205")
  assert.doesNotMatch(without, /notify_on_output/)

  const withNotifications = getShellToolDescription(false, "dsv3-1205", { enableJobProgressNotifications: true })
  assert.match(withNotifications, /You can monitor commands by configuring `notify_on_output`\./)
})

test("the default block-until duration is written in the unit a reader would use", () => {
  assert.match(getShellToolDescription(false, "dsv3-1205", { enableBlockUntilMs: true, defaultBlockUntilMs: 90_000 }), /\(default 90s\)/)
  assert.match(getShellToolDescription(false, "dsv3-1205", { enableBlockUntilMs: true, defaultBlockUntilMs: 90_500 }), /\(default 90500ms\)/)
})

// ---------------------------------------------------------------------------------------------
// the parameters per prompt version
// ---------------------------------------------------------------------------------------------

test("the earliest schema has a required background flag and no timeout", () => {
  const schema = getShellToolParametersSchema(false, "something-else")
  assert.deepEqual(Object.keys(schema.shape).sort(), ["command", "explanation", "is_background"])
  assert.equal(schema.safeParse({ command: "ls", is_background: false }).success, true)
  assert.equal(schema.safeParse({ command: "ls" }).success, false)
})

test("a later schema has a working directory and a timeout instead", () => {
  const schema = getShellToolParametersSchema(false, "dsv3-1205")
  assert.deepEqual(Object.keys(schema.shape).sort(), ["command", "description", "is_background", "timeout", "working_directory"])
  assert.equal(schema.safeParse({ command: "ls" }).success, true)
  assert.deepEqual(schema.parse({ command: "ls", timeout: "5000" }).timeout, 5_000)
})

test("the block-until schemas replace the timeout with the duration", () => {
  const optional = getShellToolParametersSchema(false, "dsv3-1205", { enableBlockUntilMs: true })
  assert.deepEqual(Object.keys(optional.shape).sort(), ["block_until_ms", "command", "description", "working_directory"])
  assert.equal(optional.safeParse({ command: "ls" }).success, true)
  assert.match(String((optional.shape.block_until_ms as z.ZodOptional<z.ZodTypeAny>).description), /Defaults to 30000ms \(30 seconds\)/)

  const required = getShellToolParametersSchema(false, "dsv3-1205", { enableBlockUntilMs: true, requireBlockUntilMs: true })
  assert.equal(required.safeParse({ command: "ls" }).success, false)
  assert.equal(required.safeParse({ command: "ls", block_until_ms: 0 }).success, true)
})

test("the newest version describes its default with a worked example", () => {
  const schema = getShellToolParametersSchema(false, "cursor-0226", { enableBlockUntilMs: true })
  assert.match(String((schema.shape.block_until_ms as z.ZodOptional<z.ZodTypeAny>).description), /recommended `block_until_ms` is 45s/)
})

test("the sandbox adds a permission argument, with the values the session may ask for", () => {
  const schema = getShellToolParametersSchema(true, "dsv3-1205", { isReadonly: true })
  assert.equal(schema.safeParse({ command: "ls", required_permissions: ["full_network"] }).success, true)
  assert.equal(schema.safeParse({ command: "ls", required_permissions: ["all"] }).success, false)

  const ordinary = getShellToolParametersSchema(true, "dsv3-1205")
  assert.equal(ordinary.safeParse({ command: "ls", required_permissions: ["git_write"] }).success, true)
})

test("the notification argument is added only when notifications are on", () => {
  const without = getShellToolParametersSchema(false, "dsv3-1205")
  assert.equal("notify_on_output" in without.shape, false)

  const withNotifications = getShellToolParametersSchema(false, "dsv3-1205", { enableJobProgressNotifications: true })
  assert.equal("notify_on_output" in withNotifications.shape, true)
  assert.equal(
    withNotifications.safeParse({ command: "ls", notify_on_output: { pattern: "ready", reason: "server up" } }).success,
    true,
  )
  assert.equal(notifyOnOutputSchema.safeParse({ pattern: "ready", reason: "server up", debounce_ms: 5_000 }).success, true)
})

test("the schema carries no sandbox argument when there is no sandbox", () => {
  assert.equal("required_permissions" in getShellToolParametersSchema(false, "something-else").shape, false)
})
