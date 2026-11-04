/** Translate a hook file written in another dialect into Slate's hook configuration. */

import { HookStep } from "../../../packages/hooks/hook-step.ts"
import type { HookConfig, HookScript } from "../../../packages/hooks/hook-config.ts"

export interface HookConfigLogger {
  warn(message: string): void
  info(message: string): void
}

/** Which source dialect a parsed hook file uses. */
export type HookConfigDialect = "nested-matcher-scripts" | "direct-scripts" | "unknown"

const noopLogger: HookConfigLogger = { warn: () => {}, info: () => {} }

/** Source event labels mapped to Slate hook steps; null means the source event is unsupported. */
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

export const HOOK_STEP_TO_EVENT: Readonly<Record<string, string>> = Object.fromEntries(
  Object.entries(EVENT_TO_HOOK_STEP)
    .filter(entry => entry[1] !== null)
    .map(([event, step]) => [step as HookStep, event]),
)

/** Source tool labels mapped to Slate tool labels; null means the source tool is unavailable. */
const SOURCE_TOOL_TO_SLATE: Readonly<Record<string, string | null>> = {
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
const TOOL_MATCHED_EVENTS = ["PreToolUse", "PostToolUse"] as const
const TRIGGER_MATCHED_EVENTS: Readonly<Record<string, readonly string[]>> = {
  SessionStart: ["startup", "resume", "clear", "compact"],
  PreCompact: ["manual", "auto"],
}

interface SourceHookScript {
  type?: string
  command?: string
  prompt?: string
  timeout?: number
}

interface SourceHookEntry {
  matcher?: string
  hooks: SourceHookScript[]
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
    const slateTool = SOURCE_TOOL_TO_SLATE[trimmedTool]
    if (slateTool === null) {
      if ((UNSUPPORTED_TOOLS as readonly string[]).includes(trimmedTool)) {
        warnings.push(`Tool "${trimmedTool}" is not supported and will be ignored`)
      }
      continue
    }
    if (slateTool !== undefined) {
      if (!transformedTools.includes(slateTool)) transformedTools.push(slateTool)
    } else {
      transformedTools.push(trimmedTool)
    }
  }
  for (const warning of warnings) logger.warn(warning)
  return transformedTools.length === 0 ? null : transformedTools.join("|")
}

function transformHookScript(script: SourceHookScript, matcher: string | undefined): HookScript | null {
  const base = {
    loop_limit: null,
    failClosed: false,
    ...(matcher && matcher !== "*" ? { matcher } : {}),
    ...(script.timeout !== undefined ? { timeout: script.timeout } : {}),
  } as const
  if (script.type === "prompt") return script.prompt ? { type: "prompt", prompt: script.prompt, ...base } : null
  return script.command ? { type: "command", command: script.command, ...base } : null
}

function transformHookEntry(entry: SourceHookEntry, event: string, logger: HookConfigLogger): HookScript[] {
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
  sourceHooks: Record<string, unknown>,
  logger: HookConfigLogger = noopLogger,
): HookConfig {
  const hooks: Record<string, HookScript[]> = {}
  for (const [eventName, entries] of Object.entries(sourceHooks)) {
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
      for (const entry of entries) scripts.push(...transformHookEntry(entry as SourceHookEntry, eventName, logger))
    } else if (entries !== undefined) {
      logger.warn(`Event "${eventName}" has an invalid value (expected an array), skipping`)
    }
    if (scripts.length > 0) hooks[step] = [...(hooks[step] ?? []), ...scripts]
  }
  return { version: 1, hooks }
}

/** Infer the input dialect from the shape of the first nonempty hook entry. */
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
