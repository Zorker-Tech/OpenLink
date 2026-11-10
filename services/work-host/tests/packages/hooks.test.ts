import { test } from "node:test"
import assert from "node:assert/strict"

import { HOOK_STEPS, HookStep } from "../../source/packages/hooks/hook-step.ts"
import {
  createValidationResult,
  isObject,
  isString,
  validateOptionalString,
} from "../../source/packages/hooks/validators/validation.ts"
import { validateHookResponseEnvelope } from "../../source/packages/hooks/validators/base-hook-response.ts"
import {
  validateBeforePromptSubmitResponse,
  validateGatedActionResponse,
  validateObservedResponse,
  validatePostToolUseResponse,
  validatePreCompactResponse,
  validatePreToolUseResponse,
  validateReadFileResponse,
  validateSessionStartResponse,
  validateStopResponse,
  validateSubagentStartResponse,
  validateWorkspaceOpenResponse,
} from "../../source/adapters/interop/hooks/foreign-hook-response-adapter.ts"
import {
  HOOK_RESPONSE_VALIDATORS,
  HOOK_STEPS_CARRYING_ADDITIONAL_CONTEXT,
  PERMISSION_HOOK_STEPS,
  WORKSPACE_LIFECYCLE_STEPS,
  validateHookResponse,
} from "../../source/packages/hooks/hook-registry.ts"
import { validateHookConfig } from "../../source/packages/hooks/hook-config-validation.ts"
import { sanitizeSystemReminderContent } from "../../source/packages/hooks/system-reminder-sanitizing.ts"
import {
  HOOK_CONTEXT_MAX_CHARACTERS,
  HookContextLimitError,
  appendHookContextEntries,
  createHookContextEntries,
  type HookContextEntry,
} from "../../source/packages/hooks-carriers/hook-additional-context.ts"
import {
  appendHookContextRemindersToToolOutput,
  renderHookContextTexts,
  renderHookContextReminder,
  renderHookContextReminders,
} from "../../source/packages/hooks-carriers/hook-context-rendering.ts"
import { HOOK_STEP_CARRIER_SPECS } from "../../source/packages/hooks-carriers/carrier-spec.ts"

function withConsoleWarn<T>(run: (warnings: string[]) => T): T {
  const warnings: string[] = []
  const original = console.warn
  console.warn = (message?: unknown) => warnings.push(String(message))
  try {
    return run(warnings)
  } finally {
    console.warn = original
  }
}

const context = (overrides: Partial<HookContextEntry> = {}): HookContextEntry =>
  ({ event: "sessionStart", text: "text", ...overrides })

// ---------------------------------------------------------------------------------------------
// hooks: the step catalogue
// ---------------------------------------------------------------------------------------------

test("the step catalogue names every step with its own wire name", () => {
  assert.equal(HOOK_STEPS.length, 21)
  for (const [key, value] of Object.entries(HookStep)) assert.equal(key, value)
  assert.deepEqual(HOOK_STEPS, Object.values(HookStep))
  assert.equal(new Set(HOOK_STEPS).size, HOOK_STEPS.length)
})

test("the catalogue carries the steps a turn actually runs at", () => {
  assert.equal(HookStep.preToolUse, "preToolUse")
  assert.equal(HookStep.postToolUseFailure, "postToolUseFailure")
  assert.equal(HookStep.workspaceOpen, "workspaceOpen")
  assert.equal(HookStep.subagentStop, "subagentStop")
})

// ---------------------------------------------------------------------------------------------
// hooks: validation primitives
// ---------------------------------------------------------------------------------------------

test("the primitive checks agree on what a string and an object are", () => {
  assert.equal(isString("x"), true)
  assert.equal(isString(""), true)
  assert.equal(isString(1), false)
  assert.equal(isString(undefined), false)

  assert.equal(isObject({}), true)
  assert.equal(isObject([]), false)
  assert.equal(isObject(null), false)
  assert.equal(isObject("x"), false)
  assert.equal(isObject(undefined), false)
})

test("a validation result is valid with no errors unless told otherwise", () => {
  assert.deepEqual(createValidationResult(true), { isValid: true, errors: [] })
  assert.deepEqual(createValidationResult(false, ["why"]), { isValid: false, errors: ["why"] })
})

test("an optional string is only reported when it is present and wrong", () => {
  const errors: string[] = []
  validateOptionalString(undefined, "additional_context", errors)
  validateOptionalString("text", "additional_context", errors)
  assert.deepEqual(errors, [])

  validateOptionalString(7, "additional_context", errors)
  assert.deepEqual(errors, ["additional_context must be a string if provided"])
})

test("the response envelope check accepts records and names non-record input", () => {
  assert.deepEqual(validateHookResponseEnvelope({ permission: "allow" }), { isValid: true, errors: [] })
  assert.deepEqual(validateHookResponseEnvelope({}), { isValid: true, errors: [] })
  for (const value of [null, [], "text", 7, undefined]) {
    assert.deepEqual(validateHookResponseEnvelope(value), { isValid: false, errors: ["Expected an object"] }, String(value))
  }
  const oneResult = validateHookResponseEnvelope({})
  oneResult.errors.push("caller-specific")
  assert.deepEqual(validateHookResponseEnvelope({}), { isValid: true, errors: [] })
})

// ---------------------------------------------------------------------------------------------
// hooks: per-step response validation
// ---------------------------------------------------------------------------------------------

test("an action-gating response accepts a decision and both messages", () => {
  assert.equal(validateGatedActionResponse({ permission: "allow" }).isValid, true)
  assert.equal(validateGatedActionResponse({ permission: "deny", user_message: "no", agent_message: "stop" }).isValid, true)
  assert.equal(validateGatedActionResponse({}).isValid, true)
})

test("an action-gating response reports a decision that is not one of the three", () => {
  const result = validateGatedActionResponse({ permission: "maybe" })
  assert.equal(result.isValid, false)
  assert.deepEqual(result.errors, ["Invalid permission value. Expected one of: allow, deny, ask, or undefined"])
})

test("the gating messages have to be text when they are there", () => {
  const result = validateGatedActionResponse({ user_message: 1, agent_message: false })
  assert.deepEqual(result.errors, [
    "user_message must be a string if provided",
    "agent_message must be a string if provided",
  ])
})

test("reading a file may be allowed or denied but not deferred", () => {
  assert.equal(validateReadFileResponse({ permission: "allow" }).isValid, true)
  const result = validateReadFileResponse({ permission: "ask" })
  assert.deepEqual(result.errors, ["Invalid permission value. Expected one of: allow, deny, or undefined"])
})

test("a subagent start decides like an action, and reports the same way", () => {
  assert.equal(validateSubagentStartResponse({ permission: "ask" }).isValid, true)
  const result = validateSubagentStartResponse({ permission: "never", user_message: 3 })
  assert.deepEqual(result.errors, [
    "Invalid permission value. Expected one of: allow, deny, ask, or undefined",
    "user_message must be a string if provided",
  ])
})

test("a tool-use response may also rewrite the call's arguments", () => {
  assert.equal(validatePreToolUseResponse({ permission: "allow", updated_input: { path: "/x" } }).isValid, true)
  const result = validatePreToolUseResponse({ updated_input: ["/x"], additional_context: 5 })
  assert.deepEqual(result.errors, [
    "Invalid updated_input value. Expected a plain object if provided",
    "additional_context must be a string if provided",
  ])
})

test("a post-tool response has nothing left to decide and may only add context", () => {
  assert.equal(validatePostToolUseResponse({ additional_context: "note" }).isValid, true)
  assert.equal(validatePostToolUseResponse({ permission: "deny" }).isValid, true)
  assert.deepEqual(validatePostToolUseResponse({ additional_context: 1 }).errors, [
    "additional_context must be a string if provided",
  ])
})

test("a submitted prompt may be stopped, worded, and added to", () => {
  assert.equal(validateBeforePromptSubmitResponse({ continue: true, user_message: "hi", additional_context: "ctx" }).isValid, true)
  const result = validateBeforePromptSubmitResponse({ continue: "yes", user_message: 1, additional_context: 2 })
  assert.deepEqual(result.errors, [
    "continue must be a boolean if provided",
    "user_message must be a string if provided",
    "additional_context must be a string if provided",
  ])
})

test("a session start may set environment variables for the session", () => {
  assert.equal(validateSessionStartResponse({ env: { PATH: "/bin", LANG: "en" } }).isValid, true)
  const result = validateSessionStartResponse({ env: { PATH: 1 }, user_message: 2 })
  assert.deepEqual(result.errors, [
    'env value for "PATH" must be a string',
    "user_message must be a string if provided",
  ])
})

test("a session start reports an environment that is not an object at all", () => {
  const result = validateSessionStartResponse({ env: ["PATH"], additional_context: 3, continue: "yes" })
  assert.deepEqual(result.errors, [
    "env must be an object if provided",
    "additional_context must be a string if provided",
    "continue must be a boolean if provided",
  ])
})

test("stopping may ask the agent to keep going", () => {
  assert.equal(validateStopResponse({ followup_message: "one more thing" }).isValid, true)
  assert.equal(validateStopResponse({}).isValid, true)
  assert.deepEqual(validateStopResponse({ followup_message: 1 }).errors, ["followup_message must be a string if provided"])
})

test("a pre-compaction response accepts an empty object and only checks a message", () => {
  assert.equal(validatePreCompactResponse({}).isValid, true)
  assert.equal(validatePreCompactResponse({ user_message: "compacting" }).isValid, true)
  assert.deepEqual(validatePreCompactResponse({ user_message: 1 }).errors, ["user_message must be a string"])
  assert.equal(validatePreCompactResponse("nope").isValid, false)
})

test("opening a workspace may name plugin paths, each of which has to be usable", () => {
  assert.equal(validateWorkspaceOpenResponse({ pluginPaths: ["/a", "/b"] }).isValid, true)
  assert.equal(validateWorkspaceOpenResponse({}).isValid, true)
  const result = validateWorkspaceOpenResponse({ pluginPaths: ["/a", 2, "   "] })
  assert.deepEqual(result.errors, [
    "pluginPaths[1] must be a string",
    "pluginPaths[2] must be a non-empty string",
  ])
  assert.deepEqual(validateWorkspaceOpenResponse({ pluginPaths: "/a" }).errors, [
    "pluginPaths must be an array of strings if provided",
  ])
})

test("a step that only observes its outcome accepts any object", () => {
  assert.equal(validateObservedResponse({ anything: "goes" }).isValid, true)
  assert.deepEqual(validateObservedResponse(null).errors, ["Expected an object"])
})

test("every step in the catalogue has a validator, and it is the one it should be", () => {
  assert.deepEqual(Object.keys(HOOK_RESPONSE_VALIDATORS).sort(), [...HOOK_STEPS].sort())
  for (const step of HOOK_STEPS) assert.equal(typeof HOOK_RESPONSE_VALIDATORS[step], "function")

  assert.equal(HOOK_RESPONSE_VALIDATORS[HookStep.stop], validateStopResponse)
  assert.equal(HOOK_RESPONSE_VALIDATORS[HookStep.subagentStop], validateStopResponse)
  assert.equal(HOOK_RESPONSE_VALIDATORS[HookStep.postToolUseFailure], validatePostToolUseResponse)
  assert.equal(HOOK_RESPONSE_VALIDATORS[HookStep.beforeTabFileRead], validateReadFileResponse)
  assert.equal(HOOK_RESPONSE_VALIDATORS[HookStep.afterFileEdit], validateObservedResponse)
  assert.equal(HOOK_RESPONSE_VALIDATORS[HookStep.workspaceOpen], validateWorkspaceOpenResponse)
})

test("validating by step routes to that step's own rules", () => {
  assert.equal(validateHookResponse(HookStep.stop, { followup_message: "more" }).isValid, true)
  assert.equal(validateHookResponse(HookStep.preCompact, "not an object").isValid, false)
  assert.equal(validateHookResponse(HookStep.preToolUse, { permission: "maybe" }).isValid, false)
})

test("an unknown runtime step falls back to the generic response-envelope check", () => {
  assert.equal(validateHookResponse("futureStep" as HookStep, {}).isValid, true)
  assert.deepEqual(validateHookResponse("futureStep" as HookStep, null).errors, ["Expected an object"])
})

test("the registry names the steps that carry context, decide, and belong to a workspace", () => {
  assert.deepEqual(
    [...HOOK_STEPS_CARRYING_ADDITIONAL_CONTEXT].sort(),
    [HookStep.sessionStart, HookStep.beforeSubmitPrompt, HookStep.preToolUse, HookStep.postToolUse, HookStep.postToolUseFailure].sort(),
  )
  assert.deepEqual(PERMISSION_HOOK_STEPS, [
    HookStep.beforeShellExecution,
    HookStep.beforeMCPExecution,
    HookStep.beforeReadFile,
    HookStep.beforeTabFileRead,
    HookStep.subagentStart,
    HookStep.preToolUse,
  ])
  assert.deepEqual(WORKSPACE_LIFECYCLE_STEPS, [HookStep.workspaceOpen])
})

// ---------------------------------------------------------------------------------------------
// hooks: reading a hook configuration file
// ---------------------------------------------------------------------------------------------

test("a configuration has to be an object with a positive integer version and hooks", () => {
  assert.deepEqual(validateHookConfig("nope"), { isValid: false, errors: ["Hooks config must be an object"] })
  assert.deepEqual(validateHookConfig({ hooks: {} }).errors, ["Config version must be a number"])
  assert.deepEqual(validateHookConfig({ version: 0, hooks: {} }).errors, ["Config version must be a positive integer"])
  assert.deepEqual(validateHookConfig({ version: 1.5, hooks: {} }).errors, ["Config version must be a positive integer"])
  assert.deepEqual(validateHookConfig({ version: 1 }).errors, ["Config hooks must be an object"])
  assert.deepEqual(validateHookConfig({ version: 1, hooks: {} }), { isValid: true, errors: [] })
})

test("an unknown hook name is reported with the names that are known", () => {
  const result = validateHookConfig({ version: 1, hooks: { beforeLunch: [] } })
  assert.equal(result.isValid, false)
  assert.match(result.errors[0] as string, /^Unknown hook type: beforeLunch\. Valid types are: beforeShellExecution, /)
})

test("a hook entry that is not an object is reported as what it should have been", () => {
  const result = validateHookConfig({ version: 1, hooks: { stop: ["run.sh"] } })
  assert.equal(result.errors.length, 1)
  assert.match(result.errors[0] as string, /^stop\[0\]: Hook script must be an object with either a 'command' property/)
})

test("a command hook needs a command, and a prompt hook needs a prompt", () => {
  assert.equal(validateHookConfig({ version: 1, hooks: { stop: [{ command: "run.sh" }] } }).isValid, true)
  assert.equal(validateHookConfig({ version: 1, hooks: { stop: [{ type: "command", command: "run.sh" }] } }).isValid, true)
  assert.deepEqual(validateHookConfig({ version: 1, hooks: { stop: [{ type: "command" }] } }).errors, [
    "stop[0]: Hook script command must be a string",
  ])
  assert.deepEqual(validateHookConfig({ version: 1, hooks: { stop: [{ type: "prompt" }] } }).errors, [
    "stop[0]: Prompt hook must have a 'prompt' property (string)",
  ])
  assert.deepEqual(validateHookConfig({ version: 1, hooks: { stop: [{ type: "prompt", prompt: "  " }] } }).errors, [
    "stop[0]: Prompt hook 'prompt' property cannot be empty",
  ])
  assert.deepEqual(validateHookConfig({ version: 1, hooks: { stop: [{ type: "prompt", prompt: "ask", model: "" }] } }).errors, [
    "stop[0]: Prompt hook 'model' cannot be an empty string",
  ])
  assert.deepEqual(validateHookConfig({ version: 1, hooks: { stop: [{ type: "prompt", prompt: "ask", model: 3 }] } }).errors, [
    "stop[0]: Prompt hook 'model' must be a string if provided",
  ])
})

test("a hook type that is neither command nor prompt is reported as such", () => {
  const result = validateHookConfig({ version: 1, hooks: { stop: [{ type: "webhook" }] } })
  assert.deepEqual(result.errors, [
    'stop[0]: Invalid hook type: "webhook". Must be "command", "prompt", or omitted (defaults to "command")',
  ])
})

test("a matcher has to be a string, and a regex when it is one", () => {
  assert.equal(validateHookConfig({ version: 1, hooks: { stop: [{ command: "x", matcher: "Bash|Read" }] } }).isValid, true)
  assert.equal(validateHookConfig({ version: 1, hooks: { stop: [{ command: "x", matcher: "" }] } }).isValid, true)
  assert.equal(validateHookConfig({ version: 1, hooks: { stop: [{ command: "x", matcher: "*" }] } }).isValid, true)
  assert.deepEqual(validateHookConfig({ version: 1, hooks: { stop: [{ command: "x", matcher: 7 }] } }).errors, [
    "stop[0]: Hook script matcher must be a string if provided",
  ])
  const broken = validateHookConfig({ version: 1, hooks: { stop: [{ command: "x", matcher: "([unclosed" }] } })
  assert.equal(broken.isValid, false)
  assert.match(broken.errors[0] as string, /^stop\[0\]: Hook script matcher "\(\[unclosed" is not a valid regex: /)
})

test("a timeout has to be a positive number of seconds, and a long one is noted", () => {
  assert.equal(validateHookConfig({ version: 1, hooks: { stop: [{ command: "x", timeout: 30 }] } }).isValid, true)
  assert.deepEqual(validateHookConfig({ version: 1, hooks: { stop: [{ command: "x", timeout: "30" }] } }).errors, [
    "stop[0]: Hook script timeout must be a number (seconds)",
  ])
  assert.deepEqual(validateHookConfig({ version: 1, hooks: { stop: [{ command: "x", timeout: 0 }] } }).errors, [
    "stop[0]: Hook script timeout must be a positive number",
  ])
  withConsoleWarn(warnings => {
    assert.equal(validateHookConfig({ version: 1, hooks: { stop: [{ command: "x", timeout: 7_200 }] } }).isValid, true)
    assert.deepEqual(warnings, ["[hooks] Hook timeout of 7200s is very long (>1 hour)"])
  })
})

test("a loop limit may be absent or null, and otherwise has to be a positive integer", () => {
  assert.equal(validateHookConfig({ version: 1, hooks: { stop: [{ command: "x", loop_limit: null }] } }).isValid, true)
  assert.equal(validateHookConfig({ version: 1, hooks: { stop: [{ command: "x", loop_limit: 3 }] } }).isValid, true)
  assert.deepEqual(validateHookConfig({ version: 1, hooks: { stop: [{ command: "x", loop_limit: "3" }] } }).errors, [
    "stop[0]: Hook script loop_limit must be a positive integer or null",
  ])
  assert.deepEqual(validateHookConfig({ version: 1, hooks: { stop: [{ command: "x", loop_limit: 1.5 }] } }).errors, [
    "stop[0]: Hook script loop_limit must be an integer",
  ])
  assert.deepEqual(validateHookConfig({ version: 1, hooks: { stop: [{ command: "x", loop_limit: 0 }] } }).errors, [
    "stop[0]: Hook script loop_limit must be a positive integer (use null for no limit)",
  ])
})

test("fail-closed has to be a boolean", () => {
  assert.equal(validateHookConfig({ version: 1, hooks: { stop: [{ command: "x", failClosed: true }] } }).isValid, true)
  assert.deepEqual(validateHookConfig({ version: 1, hooks: { stop: [{ command: "x", failClosed: "yes" }] } }).errors, [
    "stop[0]: Hook script failClosed must be a boolean",
  ])
})

test("every entry in a hook's list is reported by its own index", () => {
  const result = validateHookConfig({
    version: 1,
    hooks: { stop: [{ command: "ok" }, { type: "prompt" }, { command: 3 }] },
  })
  assert.deepEqual(result.errors, [
    "stop[1]: Prompt hook must have a 'prompt' property (string)",
    "stop[2]: Hook script command must be a string",
  ])
})

test("a hook list that is not a list is reported once for the hook", () => {
  assert.deepEqual(validateHookConfig({ version: 1, hooks: { stop: { command: "x" } } }).errors, [
    "stop must be an array of hook scripts",
  ])
})

test("a deprecated stop limit is called out but does not fail the configuration", () => {
  withConsoleWarn(warnings => {
    const result = validateHookConfig({ version: 1, hooks: {}, stop_hook_loop_limit: 3 })
    assert.equal(result.isValid, true)
    assert.deepEqual(warnings, [
      "[hooks] DEPRECATION WARNING: 'stop_hook_loop_limit' is deprecated. Use 'loop_limit' on individual hook scripts instead. The configured value is being ignored.",
    ])
  })
})

test("a hook with no entries is accepted, and one with no value is skipped", () => {
  assert.equal(validateHookConfig({ version: 1, hooks: { stop: [] } }).isValid, true)
  assert.equal(validateHookConfig({ version: 1, hooks: { stop: undefined } }).isValid, true)
})

// ---------------------------------------------------------------------------------------------
// hooks: content that must not look like platform instructions
// ---------------------------------------------------------------------------------------------

test("a system reminder tag written by a hook is defused on both sides", () => {
  assert.equal(
    sanitizeSystemReminderContent("before <system_reminder> middle </system_reminder> after"),
    "before <system_reminder_> middle </system_reminder_> after",
  )
  assert.equal(sanitizeSystemReminderContent("<SYSTEM_REMINDER>"), "<system_reminder_>")
  assert.equal(sanitizeSystemReminderContent("nothing to do"), "nothing to do")
  assert.equal(
    sanitizeSystemReminderContent("<system_reminder>a</system_reminder><system_reminder>b"),
    "<system_reminder_>a</system_reminder_><system_reminder_>b",
  )
})

// ---------------------------------------------------------------------------------------------
// hooks-carriers: context on its way to the model
// ---------------------------------------------------------------------------------------------

test("context is trimmed, and empty context is not context", () => {
  assert.deepEqual(createHookContextEntries({ event: "stop", text: "  \n " }), [])
  assert.deepEqual(createHookContextEntries({ event: "stop", text: "" }), [])
  assert.deepEqual(createHookContextEntries({ event: "stop", text: null }), [])
  assert.deepEqual(createHookContextEntries({ event: "stop", text: undefined }), [])

  const [carried] = createHookContextEntries({ event: "stop", text: "  keep me  " })
  assert.equal(carried?.event, "stop")
  assert.equal(carried?.text, "keep me")
})

test("context past the limit is refused, and says by how much", () => {
  assert.equal(HOOK_CONTEXT_MAX_CHARACTERS, 10_000)
  const atLimit = createHookContextEntries({
    event: "preToolUse",
    text: "x".repeat(HOOK_CONTEXT_MAX_CHARACTERS),
  })
  assert.equal(atLimit.length, 1)

  assert.throws(
    () => createHookContextEntries({
      event: "preToolUse",
      text: "x".repeat(HOOK_CONTEXT_MAX_CHARACTERS + 1),
    }),
    (error: unknown) => {
      assert.ok(error instanceof HookContextLimitError)
      assert.equal(error.event, "preToolUse")
      assert.equal(error.actualCharacters, HOOK_CONTEXT_MAX_CHARACTERS + 1)
      assert.equal(error.maximumCharacters, HOOK_CONTEXT_MAX_CHARACTERS)
      assert.match(error.message, /Hook response for preToolUse contained 10001 characters; the limit is 10000\./)
      return true
    },
  )
})

test("context is only appended to a collector that exists", () => {
  const collector = [context()]
  appendHookContextEntries(undefined, [context()])
  appendHookContextEntries(collector, [])
  assert.equal(collector.length, 1)

  appendHookContextEntries(collector, [context({ text: "second" })])
  assert.equal(collector.length, 2)
  assert.equal(collector[1]?.text, "second")
})

test("rendering drops what is empty and trims what is not", () => {
  assert.deepEqual(renderHookContextTexts([]), [])
  assert.deepEqual(
    renderHookContextTexts([context({ text: "  one  " }), context({ text: "   " }), context({ text: "two" })]),
    ["one", "two"],
  )
})

test("rendered context reaches the model as a sanitized system reminder", () => {
  const reminders = renderHookContextReminders([context({ text: " note <system_reminder> " })])
  assert.deepEqual(reminders, ["<system_reminder>\nnote <system_reminder_>\n</system_reminder>"])
})

test("reminders are appended to the tool result and to its text parts together", () => {
  const textParts: string[] = ["existing"]
  const toolResultContent: Array<{ type: "text"; text: string }> = [{ type: "text", text: "existing" }]
  appendHookContextRemindersToToolOutput(textParts, toolResultContent, [context({ text: "note" })])
  assert.deepEqual(textParts, ["existing", "<system_reminder>\nnote\n</system_reminder>"])
  assert.deepEqual(toolResultContent, [
    { type: "text", text: "existing" },
    { type: "text", text: "<system_reminder>\nnote\n</system_reminder>" },
  ])
})

test("a single reminder is rendered only for content that fits", () => {
  assert.equal(renderHookContextReminder("  note  "), "<system_reminder>\nnote\n</system_reminder>")
  assert.equal(renderHookContextReminder("<system_reminder>"), "<system_reminder>\n<system_reminder_>\n</system_reminder>")
  assert.equal(renderHookContextReminder("   "), undefined)
  assert.equal(renderHookContextReminder(null), undefined)
  assert.equal(renderHookContextReminder(undefined), undefined)
})

test("an oversize single reminder is reported to the caller instead of rendered", () => {
  const oversize: Array<[number, number]> = []
  const rendered = renderHookContextReminder(
    "x".repeat(HOOK_CONTEXT_MAX_CHARACTERS + 5),
    (actualCharacters, maximumCharacters) => oversize.push([actualCharacters, maximumCharacters]),
  )
  assert.equal(rendered, undefined)
  assert.deepEqual(oversize, [[HOOK_CONTEXT_MAX_CHARACTERS + 5, HOOK_CONTEXT_MAX_CHARACTERS]])
})

test("the carrier specs cover exactly the steps that carry context", () => {
  assert.deepEqual(
    Object.keys(HOOK_STEP_CARRIER_SPECS).sort(),
    [HookStep.sessionStart, HookStep.beforeSubmitPrompt, HookStep.preToolUse, HookStep.postToolUse, HookStep.postToolUseFailure].sort(),
  )
  for (const [step, spec] of Object.entries(HOOK_STEP_CARRIER_SPECS)) {
    assert.equal(spec.event, step)
  }
})
