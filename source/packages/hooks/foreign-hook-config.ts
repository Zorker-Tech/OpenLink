/**
 * Reading a hook configuration written by another tool.
 *
 * A hook file in the wild uses a different dialect from ours: its events are PascalCase, its entries
 * wrap a `hooks` array around a matcher, and its tool names are not ours either. This translates one
 * into ours so that such a file can be used as it is — the events it names are mapped onto our steps,
 * its tool matchers onto our tool names, and anything it asks for that we cannot honour (a tool we do
 * not have, an event we do not run) is reported to the caller's logger instead of being dropped in
 * silence, because a hook that never fires is worse than one that is refused.
 */

import { HookStep } from "./hook-step.ts"

export interface HookConfigLogger {
  warn(message: string): void
  info(message: string): void
}

/** Which dialect a parsed configuration file is written in. */
export type HookConfigDialect = "nested-matcher-scripts" | "direct-scripts" | "unknown"

export interface HookScript {
  type: "command" | "prompt"
  command?: string
  prompt?: string
  matcher?: string
  timeout?: number
  loop_limit: null
  failClosed: false
}

export interface HookConfig {
  version: 1
  hooks: Record<string, HookScript[]>
}

const noopLogger: HookConfigLogger = { warn: () => {}, info: () => {} }

/** Their event names, and the step of ours each one runs at; a null is an event we do not run. */
const EVENT_TO_HOOK_STEP: Readonly<Record<string, HookStep | null>> = {
  PreToolUse: HookStep.preToolUse,
  PermissionRequest: null,
  PostToolUse: HookStep.postToolUse,
  UserPromptSubmit: HookStep.beforeSubmitPrompt,
  Stop: HookStep.stop,
  SubagentStop: HookStep.subagentStop,
  SessionStart: HookStep.sessionStart,
  SessionEnd: HookStep.sessionEnd,
  PreCompact: HookStep.preCompact,
  Notification: null,
}

const HOOK_STEP_TO_EVENT: Readonly<Record<string, string>> = Object.fromEntries(
  Object.entries(EVENT_TO_HOOK_STEP)
    .filter(entry => entry[1] !== null)
    .map(([event, step]) => [step as HookStep, event]),
)

/** Their tool names, and ours; a null is a tool we do not have. */
const THEIR_TOOL_TO_OURS: Readonly<Record<string, string | null>> = {
  Bash: "Shell",
  Read: "Read",
  Write: "Write",
  Edit: "Write",
  Glob: null,
  Grep: "Grep",
  WebFetch: "WebFetch",
  WebSearch: "WebSearch",
  Task: "Task",
}

const UNSUPPORTED_TOOLS = ["Glob"] as const
const UNSUPPORTED_EVENTS = ["Notification", "PermissionRequest"] as const

/** The events whose entries may carry a tool matcher, and the two whose matcher names a trigger. */
const TOOL_MATCHED_EVENTS = ["PreToolUse", "PostToolUse"] as const
const TRIGGER_MATCHED_EVENTS: Readonly<Record<string, readonly string[]>> = {
  SessionStart: ["startup", "resume", "clear", "compact"],
  PreCompact: ["manual", "auto"],
}

interface TheirHookScript {
  type?: string
  command?: string
  prompt?: string
  timeout?: number
}

interface TheirHookEntry {
  matcher?: string
  hooks: TheirHookScript[]
}

function transformToolMatcher(matcher: string | undefined, logger: HookConfigLogger): string | null {
  if (!matcher || matcher === "*") return "*"
  const transformedTools: string[] = []
  const warnings: string[] = []
  for (const tool of matcher.split("|")) {
    const trimmedTool = tool.trim()
    if (trimmedTool.startsWith("mcp__")) {
      const parts = trimmedTool.split("__")
      if (parts.length >= 3) {
        transformedTools.push(`MCP:${parts.slice(2).join("__")}`)
        continue
      }
    }
    const ourTool = THEIR_TOOL_TO_OURS[trimmedTool]
    if (ourTool === null) {
      if ((UNSUPPORTED_TOOLS as readonly string[]).includes(trimmedTool)) {
        warnings.push(`Tool "${trimmedTool}" is not supported and will be ignored`)
      }
      continue
    }
    if (ourTool !== undefined) {
      if (!transformedTools.includes(ourTool)) transformedTools.push(ourTool)
    } else {
      transformedTools.push(trimmedTool)
    }
  }
  for (const warning of warnings) logger.warn(warning)
  return transformedTools.length === 0 ? null : transformedTools.join("|")
}

function transformHookScript(script: TheirHookScript, matcher: string | undefined): HookScript | null {
  const base = {
    loop_limit: null,
    failClosed: false,
    ...(matcher && matcher !== "*" ? { matcher } : {}),
    ...(script.timeout !== undefined ? { timeout: script.timeout } : {}),
  } as const
  if (script.type === "prompt") return script.prompt ? { type: "prompt", prompt: script.prompt, ...base } : null
  return script.command ? { type: "command", command: script.command, ...base } : null
}

function transformHookEntry(entry: TheirHookEntry, event: string, logger: HookConfigLogger): HookScript[] {
  const usesToolMatcher = (TOOL_MATCHED_EVENTS as readonly string[]).includes(event)
  let effectiveMatcher: string | undefined
  if (usesToolMatcher) {
    const transformed = transformToolMatcher(entry.matcher, logger)
    if (transformed === null) {
      logger.warn(`All tools in matcher "${entry.matcher}" are unsupported, skipping hooks`)
      return []
    }
    effectiveMatcher = transformed === "*" ? undefined : transformed
  } else if (event in TRIGGER_MATCHED_EVENTS) {
    const triggers = TRIGGER_MATCHED_EVENTS[event] as readonly string[]
    if (entry.matcher && entry.matcher !== "*" && entry.matcher !== "" && triggers.includes(entry.matcher)) {
      logger.warn(`${event} trigger matcher "${entry.matcher}" is not supported, hooks will fire for all triggers`)
    }
    effectiveMatcher = undefined
  } else {
    effectiveMatcher = undefined
  }
  const result: HookScript[] = []
  for (const script of entry.hooks) {
    const transformed = transformHookScript(script, effectiveMatcher)
    if (transformed) result.push(transformed)
  }
  return result
}

export function transformForeignHookConfig(
  foreignHooks: Record<string, unknown>,
  logger: HookConfigLogger = noopLogger,
): HookConfig {
  const hooks: Record<string, HookScript[]> = {}
  for (const [eventName, entries] of Object.entries(foreignHooks)) {
    if ((UNSUPPORTED_EVENTS as readonly string[]).includes(eventName)) {
      logger.warn(`Event "${eventName}" is not supported and will be ignored`)
      continue
    }
    const step = EVENT_TO_HOOK_STEP[eventName]
    if (!step) {
      logger.warn(`Unknown event "${eventName}", skipping`)
      continue
    }
    const scripts: HookScript[] = []
    if (Array.isArray(entries)) {
      for (const entry of entries) scripts.push(...transformHookEntry(entry as TheirHookEntry, eventName, logger))
    } else if (entries !== undefined) {
      logger.warn(`Event "${eventName}" has an invalid value (expected an array), skipping`)
    }
    if (scripts.length > 0) hooks[step] = [...(hooks[step] ?? []), ...scripts]
  }
  return { version: 1, hooks }
}

/**
 * Which dialect a parsed file is written in, decided by the shape of its first entry: an entry that
 * wraps a `hooks` array is the nested one, an entry that is itself a script is ours.
 */
export function detectHookConfigDialect(value: unknown): HookConfigDialect {
  if (typeof value !== "object" || value === null) return "unknown"
  const hooks = typeof (value as Record<string, unknown>).hooks === "object" && (value as Record<string, unknown>).hooks !== null
    ? (value as Record<string, unknown>).hooks as Record<string, unknown>
    : null
  if (!hooks) return "unknown"
  for (const candidate of Object.values(hooks)) {
    if (!Array.isArray(candidate) || candidate.length === 0) continue
    const first = candidate[0]
    if (typeof first !== "object" || first === null) continue
    if ("hooks" in first && Array.isArray((first as Record<string, unknown>).hooks)) return "nested-matcher-scripts"
    if ("command" in first || "prompt" in first || "type" in first) return "direct-scripts"
  }
  return "unknown"
}

export { HOOK_STEP_TO_EVENT }
