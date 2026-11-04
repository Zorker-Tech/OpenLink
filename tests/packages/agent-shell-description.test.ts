import { test } from "node:test"
import assert from "node:assert/strict"
import { z } from "zod"

import {
  getShellToolDescription,
  getShellToolParametersSchema,
  notifyOnOutputSchema,
  SlateShellPromptProfile,
} from "../../source/packages/agent/tools/core/shell/shell-tool-description.ts"

const noSandbox = { sandboxEnabled: false }

// ---------------------------------------------------------------------------------------------
// the description per prompt version
// ---------------------------------------------------------------------------------------------

test("the initial profile receives concise command guidance", () => {
  const description = getShellToolDescription(false, SlateShellPromptProfile.INITIAL)
  assert.match(description, /^Run commands in the active project shell/)
  assert.match(description, /Keep each command input to one line/)
})

test("the session profile explains shell context and tool preferences", () => {
  const description = getShellToolDescription(false, SlateShellPromptProfile.SESSION)
  assert.match(description, /^Run a command in a persistent shell session\./)
  assert.match(description, /Quote paths that contain spaces/)
  assert.match(description, /dedicated file and search tools/)
  assert.doesNotMatch(description, /Run commands in the active project shell/)
})

test("the newest version says it waits for the block-until duration", () => {
  const description = getShellToolDescription(false, SlateShellPromptProfile.STREAMING)
  assert.match(description, /^Run a shell command and wait for output for the configured block_until_ms duration\./)
})

test("a session that can background commands is told how to manage them", () => {
  const description = getShellToolDescription(false, SlateShellPromptProfile.SESSION, { enableBlockUntilMs: true, defaultBlockUntilMs: 45_000 })
  assert.match(description, /Managing commands that outlast the wait:/)
  assert.match(description, /\(default 45s\)/)
  assert.match(description, /Set block_until_ms to 0 to start in the background immediately/)
})

test("a required block-until duration is not described as having a default", () => {
  const description = getShellToolDescription(false, SlateShellPromptProfile.SESSION, { enableBlockUntilMs: true, requireBlockUntilMs: true })
  assert.match(description, /Commands still running after block_until_ms continue in the background/)
  assert.doesNotMatch(description, /\(default /)
})

test("how to monitor a backgrounded command follows what the session can do", () => {
  const byFile = getShellToolDescription(false, SlateShellPromptProfile.SESSION, { enableBlockUntilMs: true })
  assert.match(byFile, /Background monitoring:/)
  assert.match(byFile, /Pause between checks and increase the wait/)

  const byNotification = getShellToolDescription(false, SlateShellPromptProfile.SESSION, {
    enableBlockUntilMs: true,
    awaitToolName: "Await",
    enableJobCompletionNotifications: true,
  })
  assert.match(byNotification, /A completion notice is sent when a background command finishes/)
  assert.match(byNotification, /ordinary commands, installs, or healthy services/)

  const byAwait = getShellToolDescription(false, SlateShellPromptProfile.SESSION, { enableBlockUntilMs: true, awaitToolName: "Await" })
  assert.match(byAwait, /Use Await to check a background command\./)
})

test("the sections that only apply sometimes are added only then", () => {
  const plain = getShellToolDescription(false, SlateShellPromptProfile.INITIAL)
  assert.doesNotMatch(plain, /Use read_file to read and search files/)

  const withReadTool = getShellToolDescription(false, SlateShellPromptProfile.INITIAL, { readToolName: "read_file" })
  assert.match(withReadTool, /Use read_file to read and search files\./)

  const withTerminalFiles = getShellToolDescription(false, SlateShellPromptProfile.INITIAL, { enableTerminalFiles: true })
  assert.match(withTerminalFiles, /Complete output is stored in a terminal file/)

  const withTmux = getShellToolDescription(false, SlateShellPromptProfile.INITIAL, { enableTmuxGuidance: true })
  assert.match(withTmux, /<tmux-backed-shell-sessions>/)

  const withSandbox = getShellToolDescription(true, SlateShellPromptProfile.INITIAL, { isReadonly: true })
  assert.match(withSandbox, /readonly sandbox/)
})

test("the sandbox description is appended without the other sections for the newest version", () => {
  const description = getShellToolDescription(true, SlateShellPromptProfile.STREAMING, { isReadonly: true })
  assert.match(description, /readonly sandbox/)
  assert.match(description, /^Run a shell command and wait for output/)
})

test("a minimal harness gets its own short description", () => {
  const description = getShellToolDescription(true, SlateShellPromptProfile.STREAMING, {
    useMinimalHarness: true,
    isReadonly: true,
    readToolName: "read_file",
  })
  assert.match(description, /^Run commands in the active workspace\./)
  assert.match(description, /The shell keeps its working directory and environment/)
  assert.match(description, /Use the workspace location supplied in the conversation/)
  assert.match(description, /Use read_file to read and search files/)
  assert.doesNotMatch(description, /Run commands in the active project shell/)
})

test("the progress notification section appears only when notifications are on", () => {
  const without = getShellToolDescription(false, SlateShellPromptProfile.SESSION)
  assert.doesNotMatch(without, /notify_on_output/)

  const withNotifications = getShellToolDescription(false, SlateShellPromptProfile.SESSION, { enableJobProgressNotifications: true })
  assert.match(withNotifications, /Output monitoring: use notify_on_output/)
})

test("the default block-until duration is written in the unit a reader would use", () => {
  assert.match(getShellToolDescription(false, SlateShellPromptProfile.SESSION, { enableBlockUntilMs: true, defaultBlockUntilMs: 90_000 }), /\(default 90s\)/)
  assert.match(getShellToolDescription(false, SlateShellPromptProfile.SESSION, { enableBlockUntilMs: true, defaultBlockUntilMs: 90_500 }), /\(default 90500ms\)/)
})

// ---------------------------------------------------------------------------------------------
// the parameters per prompt version
// ---------------------------------------------------------------------------------------------

test("the earliest schema has a required background flag and no timeout", () => {
  const schema = getShellToolParametersSchema(false, SlateShellPromptProfile.INITIAL)
  assert.deepEqual(Object.keys(schema.shape).sort(), ["command", "explanation", "is_background"])
  assert.equal(schema.safeParse({ command: "ls", is_background: false }).success, true)
  assert.equal(schema.safeParse({ command: "ls" }).success, false)
})

test("a later schema has a working directory and a timeout instead", () => {
  const schema = getShellToolParametersSchema(false, SlateShellPromptProfile.SESSION)
  assert.deepEqual(Object.keys(schema.shape).sort(), ["command", "description", "is_background", "timeout", "working_directory"])
  assert.equal(schema.safeParse({ command: "ls" }).success, true)
  assert.deepEqual(schema.parse({ command: "ls", timeout: "5000" }).timeout, 5_000)
})

test("the block-until schemas replace the timeout with the duration", () => {
  const optional = getShellToolParametersSchema(false, SlateShellPromptProfile.SESSION, { enableBlockUntilMs: true })
  assert.deepEqual(Object.keys(optional.shape).sort(), ["block_until_ms", "command", "description", "working_directory"])
  assert.equal(optional.safeParse({ command: "ls" }).success, true)
  assert.match(String((optional.shape.block_until_ms as z.ZodOptional<z.ZodTypeAny>).description), /Defaults to 30000ms \(30 seconds\)/)

  const required = getShellToolParametersSchema(false, SlateShellPromptProfile.SESSION, { enableBlockUntilMs: true, requireBlockUntilMs: true })
  assert.equal(required.safeParse({ command: "ls" }).success, false)
  assert.equal(required.safeParse({ command: "ls", block_until_ms: 0 }).success, true)
})

test("the newest version describes its default with a worked example", () => {
  const schema = getShellToolParametersSchema(false, SlateShellPromptProfile.STREAMING, { enableBlockUntilMs: true })
  assert.match(String((schema.shape.block_until_ms as z.ZodOptional<z.ZodTypeAny>).description), /command expected to take 40 seconds can use 45 seconds/)
})

test("the sandbox adds a permission argument, with the values the session may ask for", () => {
  const schema = getShellToolParametersSchema(true, SlateShellPromptProfile.SESSION, { isReadonly: true })
  assert.equal(schema.safeParse({ command: "ls", required_permissions: ["full_network"] }).success, true)
  assert.equal(schema.safeParse({ command: "ls", required_permissions: ["all"] }).success, false)

  const ordinary = getShellToolParametersSchema(true, SlateShellPromptProfile.SESSION)
  assert.equal(ordinary.safeParse({ command: "ls", required_permissions: ["git_write"] }).success, true)
})

test("the notification argument is added only when notifications are on", () => {
  const without = getShellToolParametersSchema(false, SlateShellPromptProfile.SESSION)
  assert.equal("notify_on_output" in without.shape, false)

  const withNotifications = getShellToolParametersSchema(false, SlateShellPromptProfile.SESSION, { enableJobProgressNotifications: true })
  assert.equal("notify_on_output" in withNotifications.shape, true)
  assert.equal(
    withNotifications.safeParse({ command: "ls", notify_on_output: { pattern: "ready", reason: "server up" } }).success,
    true,
  )
  assert.equal(notifyOnOutputSchema.safeParse({ pattern: "ready", reason: "server up", debounce_ms: 5_000 }).success, true)
})

test("the schema carries no sandbox argument when there is no sandbox", () => {
  assert.equal("required_permissions" in getShellToolParametersSchema(false, SlateShellPromptProfile.INITIAL).shape, false)
})
