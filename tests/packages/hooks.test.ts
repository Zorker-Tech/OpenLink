import { test } from "node:test"
import assert from "node:assert/strict"

import { HookAdditionalContext } from "../../source/packages/proto/generated/agent/v1/hook_additional_context_pb.ts"
import { HOOK_STEPS, HookStep } from "../../source/packages/hooks/hook-step.ts"
import {
  createValidationResult,
  isObject,
  isString,
  validateOptionalString,
} from "../../source/packages/hooks/validators/validation.ts"
import { validateBaseHookResponse } from "../../source/packages/hooks/validators/base-hook-response.ts"
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
} from "../../source/packages/hooks/validators/hook-responses.ts"
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
  detectHookConfigDialect,
  transformForeignHookConfig,
  type HookConfigLogger,
} from "../../source/packages/hooks/foreign-hook-config.ts"
import {
  HOOK_ADDITIONAL_CONTEXT_MAX_CHARS,
  HookAdditionalContextTooLargeError,
  appendHookAdditionalContexts,
  createHookAdditionalContexts,
} from "../../source/packages/hooks-carriers/hook-additional-context.ts"
import {
  appendHookContextRemindersToCoreToolResult,
  renderHookAdditionalContextContents,
  renderHookAdditionalContextSystemReminder,
  renderHookAdditionalContextSystemReminders,
} from "../../source/packages/hooks-carriers/hook-context-rendering.ts"
import { HOOK_STEP_CARRIER_SPECS } from "../../source/packages/hooks-carriers/carrier-spec.ts"

function capturingLogger(): { logger: HookConfigLogger; warnings: string[] } {
  const warnings: string[] = []
  return { logger: { warn: message => warnings.push(message), info: () => {} }, warnings }
}

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

const context = (overrides: Partial<HookAdditionalContext> = {}): HookAdditionalContext =>
  new HookAdditionalContext({ hookEventName: "sessionStart", content: "text", ...overrides })

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

test("the base response check accepts objects and names what it got instead", () => {
  assert.deepEqual(validateBaseHookResponse({ permission: "allow" }), { isValid: true, errors: [] })
  assert.deepEqual(validateBaseHookResponse({}), { isValid: true, errors: [] })
  for (const value of [null, [], "text", 7, undefined]) {
    assert.deepEqual(validateBaseHookResponse(value), { isValid: false, errors: ["Expected an object"] }, String(value))
  }
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
// hooks: a configuration written by another tool
// ---------------------------------------------------------------------------------------------

test("a foreign configuration is translated event by event and script by script", () => {
  const { logger, warnings } = capturingLogger()
  const config = transformForeignHookConfig({
    PreToolUse: [{ matcher: "Bash", hooks: [{ type: "command", command: "guard.sh", timeout: 10 }] }],
    Stop: [{ hooks: [{ type: "prompt", prompt: "was that complete?" }] }],
  }, logger)
  assert.deepEqual(config, {
    version: 1,
    hooks: {
      preToolUse: [{ type: "command", command: "guard.sh", matcher: "Shell", timeout: 10, loop_limit: null, failClosed: false }],
      stop: [{ type: "prompt", prompt: "was that complete?", loop_limit: null, failClosed: false }],
    },
  })
  assert.deepEqual(warnings, [])
})

test("an event we do not run is reported and left out", () => {
  const { logger, warnings } = capturingLogger()
  const config = transformForeignHookConfig({
    Notification: [{ hooks: [{ command: "notify.sh" }] }],
    UnknownEvent: [{ hooks: [{ command: "x.sh" }] }],
  }, logger)
  assert.deepEqual(config.hooks, {})
  assert.deepEqual(warnings, [
    'Event "Notification" is not supported and will be ignored',
    'Unknown event "UnknownEvent", skipping',
  ])
})

test("an event whose value is not a list is reported and skipped", () => {
  const { logger, warnings } = capturingLogger()
  const config = transformForeignHookConfig({ Stop: { hooks: [{ command: "x.sh" }] } }, logger)
  assert.deepEqual(config.hooks, {})
  assert.deepEqual(warnings, ['Event "Stop" has an invalid value (expected an array), skipping'])
})

test("tool names are translated, deduplicated, and MCP tools keep their server", () => {
  const { logger, warnings } = capturingLogger()
  const config = transformForeignHookConfig({
    PreToolUse: [
      { matcher: "Bash|Edit|Write", hooks: [{ command: "a.sh" }] },
      { matcher: "mcp__server__do_thing|mcp__server__other", hooks: [{ command: "b.sh" }] },
    ],
  }, logger)
  assert.equal(config.hooks.preToolUse?.[0]?.matcher, "Shell|Write")
  assert.equal(config.hooks.preToolUse?.[1]?.matcher, "MCP:do_thing|MCP:other")
  assert.deepEqual(warnings, [])
})

test("a tool we do not have is reported, and a matcher left with nothing is skipped", () => {
  const { logger, warnings } = capturingLogger()
  const config = transformForeignHookConfig({
    PreToolUse: [
      { matcher: "Glob|Bash", hooks: [{ command: "a.sh" }] },
      { matcher: "Glob", hooks: [{ command: "b.sh" }] },
    ],
  }, logger)
  assert.equal(config.hooks.preToolUse?.length, 1)
  assert.equal(config.hooks.preToolUse?.[0]?.matcher, "Shell")
  assert.deepEqual(warnings, [
    'Tool "Glob" is not supported and will be ignored',
    'Tool "Glob" is not supported and will be ignored',
    'All tools in matcher "Glob" are unsupported, skipping hooks',
  ])
})

test("a matcher that is a wildcard, or missing, applies to every tool", () => {
  const { logger } = capturingLogger()
  const config = transformForeignHookConfig({
    PreToolUse: [
      { matcher: "*", hooks: [{ command: "a.sh" }] },
      { hooks: [{ command: "b.sh" }] },
    ],
  }, logger)
  assert.equal(config.hooks.preToolUse?.[0]?.matcher, undefined)
  assert.equal(config.hooks.preToolUse?.[1]?.matcher, undefined)
})

test("a matcher on a step that has no tools is dropped, and a trigger matcher is explained", () => {
  const { logger, warnings } = capturingLogger()
  const config = transformForeignHookConfig({
    Stop: [{ matcher: "whatever", hooks: [{ command: "a.sh" }] }],
    SessionStart: [
      { matcher: "startup", hooks: [{ command: "b.sh" }] },
      { matcher: "something-else", hooks: [{ command: "c.sh" }] },
    ],
  }, logger)
  assert.equal(config.hooks.stop?.[0]?.matcher, undefined)
  assert.equal(config.hooks.sessionStart?.length, 2)
  assert.deepEqual(warnings, [
    'SessionStart trigger matcher "startup" is not supported, hooks will fire for all triggers',
  ])
})

test("scripts without what they need are dropped, and several entries merge into one step", () => {
  const { logger } = capturingLogger()
  const config = transformForeignHookConfig({
    PreToolUse: [
      { matcher: "Bash", hooks: [{ type: "prompt" }, { command: "" }, { command: "keep.sh" }] },
      { matcher: "Read", hooks: [{ command: "also.sh" }] },
    ],
  }, logger)
  assert.deepEqual(config.hooks.preToolUse?.map(script => script.command), ["keep.sh", "also.sh"])
})

test("the dialect of a configuration is read from the shape of its first entry", () => {
  assert.equal(detectHookConfigDialect({ hooks: { stop: [{ matcher: "*", hooks: [{ command: "x" }] }] } }), "nested-matcher-scripts")
  assert.equal(detectHookConfigDialect({ hooks: { stop: [{ command: "x" }] } }), "direct-scripts")
  assert.equal(detectHookConfigDialect({ hooks: { stop: [{ type: "command" }] } }), "direct-scripts")
  assert.equal(detectHookConfigDialect({ hooks: { stop: [] } }), "unknown")
  assert.equal(detectHookConfigDialect({ hooks: { stop: ["x"] } }), "unknown")
  assert.equal(detectHookConfigDialect({ hooks: {} }), "unknown")
  assert.equal(detectHookConfigDialect({}), "unknown")
  assert.equal(detectHookConfigDialect(null), "unknown")
  assert.equal(detectHookConfigDialect("nope"), "unknown")
})

// ---------------------------------------------------------------------------------------------
// hooks-carriers: context on its way to the model
// ---------------------------------------------------------------------------------------------

test("context is trimmed, and empty context is not context", () => {
  assert.deepEqual(createHookAdditionalContexts({ hookEventName: "stop", additionalContext: "  \n " }), [])
  assert.deepEqual(createHookAdditionalContexts({ hookEventName: "stop", additionalContext: "" }), [])
  assert.deepEqual(createHookAdditionalContexts({ hookEventName: "stop", additionalContext: null }), [])
  assert.deepEqual(createHookAdditionalContexts({ hookEventName: "stop", additionalContext: undefined }), [])

  const [carried] = createHookAdditionalContexts({ hookEventName: "stop", additionalContext: "  keep me  " })
  assert.equal(carried?.hookEventName, "stop")
  assert.equal(carried?.content, "keep me")
})

test("context past the limit is refused, and says by how much", () => {
  assert.equal(HOOK_ADDITIONAL_CONTEXT_MAX_CHARS, 10_000)
  const atLimit = createHookAdditionalContexts({
    hookEventName: "preToolUse",
    additionalContext: "x".repeat(HOOK_ADDITIONAL_CONTEXT_MAX_CHARS),
  })
  assert.equal(atLimit.length, 1)

  assert.throws(
    () => createHookAdditionalContexts({
      hookEventName: "preToolUse",
      additionalContext: "x".repeat(HOOK_ADDITIONAL_CONTEXT_MAX_CHARS + 1),
    }),
    (error: unknown) => {
      assert.ok(error instanceof HookAdditionalContextTooLargeError)
      assert.equal(error.hookEventName, "preToolUse")
      assert.equal(error.actualLength, HOOK_ADDITIONAL_CONTEXT_MAX_CHARS + 1)
      assert.equal(error.maxLength, HOOK_ADDITIONAL_CONTEXT_MAX_CHARS)
      assert.match(error.message, /Hook additional_context for preToolUse is 10001 chars \(max 10000\)\./)
      return true
    },
  )
})

test("context is only appended to a collector that exists", () => {
  const collector = [context()]
  appendHookAdditionalContexts(undefined, [context()])
  appendHookAdditionalContexts(collector, [])
  assert.equal(collector.length, 1)

  appendHookAdditionalContexts(collector, [context({ content: "second" })])
  assert.equal(collector.length, 2)
  assert.equal(collector[1]?.content, "second")
})

test("rendering drops what is empty and trims what is not", () => {
  assert.deepEqual(renderHookAdditionalContextContents([]), [])
  assert.deepEqual(
    renderHookAdditionalContextContents([context({ content: "  one  " }), context({ content: "   " }), context({ content: "two" })]),
    ["one", "two"],
  )
})

test("rendered context reaches the model as a sanitized system reminder", () => {
  const reminders = renderHookAdditionalContextSystemReminders([context({ content: " note <system_reminder> " })])
  assert.deepEqual(reminders, ["<system_reminder>\nnote <system_reminder_>\n</system_reminder>"])
})

test("reminders are appended to the tool result and to its text parts together", () => {
  const textParts: string[] = ["existing"]
  const toolResultContent: Array<{ type: "text"; text: string }> = [{ type: "text", text: "existing" }]
  appendHookContextRemindersToCoreToolResult(textParts, toolResultContent, [context({ content: "note" })])
  assert.deepEqual(textParts, ["existing", "<system_reminder>\nnote\n</system_reminder>"])
  assert.deepEqual(toolResultContent, [
    { type: "text", text: "existing" },
    { type: "text", text: "<system_reminder>\nnote\n</system_reminder>" },
  ])
})

test("a single reminder is rendered only for content that fits", () => {
  assert.equal(renderHookAdditionalContextSystemReminder("  note  "), "<system_reminder>\nnote\n</system_reminder>")
  assert.equal(renderHookAdditionalContextSystemReminder("<system_reminder>"), "<system_reminder>\n<system_reminder_>\n</system_reminder>")
  assert.equal(renderHookAdditionalContextSystemReminder("   "), undefined)
  assert.equal(renderHookAdditionalContextSystemReminder(null), undefined)
  assert.equal(renderHookAdditionalContextSystemReminder(undefined), undefined)
})

test("an oversize single reminder is reported to the caller instead of rendered", () => {
  const oversize: Array<[number, number]> = []
  const rendered = renderHookAdditionalContextSystemReminder(
    "x".repeat(HOOK_ADDITIONAL_CONTEXT_MAX_CHARS + 5),
    (actualLength, maxLength) => oversize.push([actualLength, maxLength]),
  )
  assert.equal(rendered, undefined)
  assert.deepEqual(oversize, [[HOOK_ADDITIONAL_CONTEXT_MAX_CHARS + 5, HOOK_ADDITIONAL_CONTEXT_MAX_CHARS]])
})

test("the carrier specs cover exactly the steps that carry context", () => {
  assert.deepEqual(
    Object.keys(HOOK_STEP_CARRIER_SPECS).sort(),
    [HookStep.sessionStart, HookStep.beforeSubmitPrompt, HookStep.preToolUse, HookStep.postToolUse, HookStep.postToolUseFailure].sort(),
  )
  for (const [step, spec] of Object.entries(HOOK_STEP_CARRIER_SPECS)) {
    assert.equal(spec.hookEventName, step)
  }
})
