/**
 * What the shell tool says about itself, per prompt version.
 *
 * A model was trained against a particular description of this tool and a particular set of arguments,
 * and it is not one description: the oldest shape has a required background flag and no timeout, a later
 * one has a working directory and a timeout, and the newest replaces the timeout with a block-until
 * duration that moves the command to the background when it elapses. Which one a session gets is decided
 * by its prompt version, because the model reading it is the one that has to recognize it.
 *
 * Around that, four things are added only when they apply: what to use for file reads instead of shell
 * text processing, that large output is kept in a terminal file rather than truncated, how to keep a
 * session alive with tmux, and what the sandbox allows. A session running against a minimal harness gets
 * a description of its own instead — short, and about the shell being stateful and about not wasting
 * tokens — because that harness's whole point is economy.
 */

import { jsx } from "../../../../prompt-jsx/index.ts"
import { renderContent } from "../../../../prompt-jsx/index.ts"
import { lenientNumber } from "../../lenient-scalars.ts"
import { getRequiredPermissionsSchema, type SandboxNetworkInfo } from "./sandbox-permissions.ts"
import { SandboxingDescriptionBody } from "./sandbox-description.ts"
import { getTmuxBackedShellSessionsSectionText } from "../../../prompts/shell-session-instructions.ts"
import { z } from "zod"

/** Slate-facing prompt profiles; provider version labels are resolved in the interop adapter. */
export const SlateShellPromptProfile = {
  INITIAL: "initial",
  SESSION: "session",
  STREAMING: "streaming",
} as const

export type SlateShellPromptProfile = typeof SlateShellPromptProfile[keyof typeof SlateShellPromptProfile]

export interface ShellToolDescriptionOptions {
  readonly isReadonly?: boolean | undefined
  readonly enableBlockUntilMs?: boolean | undefined
  readonly enableTmuxGuidance?: boolean | undefined
  readonly sandboxNetworkInfo?: SandboxNetworkInfo | undefined
  readonly awaitToolName?: string | undefined
  readonly readToolName?: string | undefined
  readonly tmuxSharedSessionName?: string | undefined
  readonly useMinimalHarness?: boolean | undefined
  readonly requireBlockUntilMs?: boolean | undefined
  readonly defaultBlockUntilMs?: number | undefined
  readonly enableJobCompletionNotifications?: boolean | undefined
  readonly enableJobProgressNotifications?: boolean | undefined
  readonly enableTerminalFiles?: boolean | undefined
}

const BASE_DESCRIPTION_INITIAL = [
  "Run commands in the active project shell on the user's behalf.",
  "Before submitting a command:",
  "1. Check the conversation for the active workspace and whether this shell continues a previous step.",
  "2. When a new shell starts, select the intended workspace before running project commands.",
  "3. Ask for approval when the action requires it, and honor edits or rejection from the user.",
  "4. Use non-interactive options when nobody can answer a prompt during execution.",
  "5. Keep each command input to one line.",
  "6. Start long-running work in the background with the provided background option.",
].join("\n")

const BASE_DESCRIPTION_SESSION = [
  "Run a command in a persistent shell session. The command may have a time limit.",
  "Before running it:",
  "1. Check whether a matching long-running process is already present so you do not start a duplicate.",
  "2. Use the workspace and shell context from this conversation; choose a working directory explicitly when needed.",
  "3. Quote paths that contain spaces.",
  "4. Prefer the workspace's dedicated file and search tools for repository inspection.",
  "5. Capture the command output and give the call a short description of its purpose.",
  "",
  "The command is required. The wait limit is optional, is measured in milliseconds, and defaults to 30 seconds.",
  "A short description should summarize the command in about five to ten words.",
].join("\n")

const notifyOnOutputSchema = z.object({
  pattern: z.string().describe("A regular expression to match against command output. Output written only to a file is not observed. Choose a specific pattern."),
  reason: z.string().describe("A short reason, five words or fewer, for watching this output."),
  debounce_ms: z.number().optional().describe("Minimum time in milliseconds between matching notifications; values below 5000ms are raised to the minimum."),
}).optional().describe("Set this only when the user asks to monitor command output.")

function formatBlockUntilDefaultForDescription(ms: number): string {
  const seconds = ms / 1_000
  return Number.isInteger(seconds) ? String(seconds) + "s" : String(ms) + "ms"
}

function formatBlockUntilMsDefaultForSchema(ms: number): string {
  const seconds = ms / 1_000
  if (Number.isInteger(seconds) && seconds > 0 && seconds <= 120) {
    return String(ms) + "ms (" + String(seconds) + " second" + (seconds === 1 ? "" : "s") + ")"
  }
  const minutes = ms / 60_000
  if (Number.isInteger(minutes) && minutes >= 1) {
    return String(ms) + "ms (" + String(minutes) + " minute" + (minutes === 1 ? "" : "s") + ")"
  }
  return String(ms) + "ms"
}

function blockUntilMsDescriptionOptional(defaultBlockUntilMs: number): string {
  return "Maximum wait in milliseconds before the command continues in the background. Defaults to " +
    formatBlockUntilMsDefaultForSchema(defaultBlockUntilMs) +
    ". Set to 0 to start it in the background immediately. The wait includes shell startup time."
}

const blockUntilMsDescriptionRequired =
  "Maximum wait in milliseconds before the command continues in the background. Set to 0 to start it in the background immediately. The wait includes shell startup time."

const parametersSchemaInitial = z.object({
  command: z.string().describe("The shell command to run."),
  is_background: z.boolean().describe("Start the process in the background when it should outlast this call."),
  explanation: z.string().optional().describe("Briefly state why the command is needed and what result it should produce."),
})

const descriptionSchema = z.string().optional().describe("A short summary of the command's purpose, usually five to ten words.")

const parametersSchemaSession = z.object({
  command: z.string().describe("Shell command to run."),
  working_directory: z.string().optional().describe("Directory for the command; defaults to the active workspace directory."),
  timeout: lenientNumber().optional().describe("Maximum wait in milliseconds; defaults to 30000."),
  description: descriptionSchema,
  is_background: z.boolean().optional().describe("Start the process in the background when it should outlast this call."),
})

const parametersSchemaWithBlockUntilShared = z.object({
  command: z.string().describe("Shell command to run."),
  working_directory: z.string().optional().describe("Directory for the command; defaults to the active workspace directory."),
  description: descriptionSchema,
})

function parametersSchemaWithBlockUntilOptional(defaultBlockUntilMs: number) {
  return parametersSchemaWithBlockUntilShared.extend({
    block_until_ms: lenientNumber().optional().describe(blockUntilMsDescriptionOptional(defaultBlockUntilMs)),
  })
}

const parametersSchemaWithBlockUntilRequired = parametersSchemaWithBlockUntilShared.extend({
  block_until_ms: lenientNumber().describe(blockUntilMsDescriptionRequired),
})

const parametersSchemaWithWaitExample = parametersSchemaWithBlockUntilShared.extend({
  block_until_ms: lenientNumber().optional().describe(
    "Maximum wait in milliseconds before the command continues in the background. Defaults to 30000ms (30 seconds). " +
    "Set to 0 to start in the background immediately. Include shell startup time and a small buffer when estimating. " +
    "For example, a command expected to take 40 seconds can use 45 seconds. This profile has no timeout argument.",
  ),
})

function outputNotificationGuidance(): string {
  return "Output monitoring: use notify_on_output only when the user asks to watch for a specific command result."
}

function commonDescriptionSections(options: ShellToolDescriptionOptions, sandboxEnabled: boolean): string[] {
  const fileToolsSection = options.readToolName === undefined
    ? undefined
    : "Use " + options.readToolName + " to read and search files."
  const terminalFilesSection = options.enableTerminalFiles === true
    ? "Complete output is stored in a terminal file; read the relevant sections directly instead of shortening it just to cap the response."
    : undefined
  const tmuxGuidanceSection = options.enableTmuxGuidance === true
    ? getTmuxBackedShellSessionsSectionText({
      ...(options.tmuxSharedSessionName === undefined ? {} : { sharedSessionName: options.tmuxSharedSessionName }),
    })
    : undefined
  const sandboxDescription = sandboxEnabled
    ? renderContent(SandboxingDescriptionBody({
      isReadonly: options.isReadonly === true,
      sandboxNetworkInfo: options.sandboxNetworkInfo,
    }))
    : undefined
  return [fileToolsSection, terminalFilesSection, tmuxGuidanceSection, sandboxDescription]
    .filter((section): section is string => section !== undefined)
}

function backgroundMonitoringGuidance(options: ShellToolDescriptionOptions): string[] {
  if (!options.awaitToolName) {
    return [
      "Background monitoring:",
      "- Open the terminal record after the command moves to the background.",
      "- Its header shows the process identifier and elapsed time; the completion record shows its exit status and total time.",
      "- Pause between checks and increase the wait when output has not changed.",
      "- Stop checking after completion, after confirming a healthy long-running service, or after identifying a hang.",
      "- End a stuck process only when doing so is safe.",
    ]
  }
  if (options.enableJobCompletionNotifications === true) {
    return [
      "A completion notice is sent when a background command finishes.",
      "Use " + options.awaitToolName + " only when a long-running job needs close attention before it finishes.",
      "For ordinary commands, installs, or healthy services, continue other work and check later if needed.",
    ]
  }
  return ["Use " + options.awaitToolName + " to check a background command."]
}

function appendSections(base: string, sections: readonly string[]): string {
  return sections.length === 0 ? base : base + "\n\n" + sections.join("\n\n")
}

export function getShellToolDescription(
  sandboxEnabled: boolean,
  profile: SlateShellPromptProfile,
  options: ShellToolDescriptionOptions = {},
): string {
  const commonSections = commonDescriptionSections(options, sandboxEnabled)
  const outputNotificationSection = options.enableJobProgressNotifications === true
    ? outputNotificationGuidance()
    : undefined
  const appendCommon = (base: string) => appendSections(base, commonSections)

  if (options.useMinimalHarness === true) {
    const minimalDescription = [
      "Run commands in the active workspace.",
      "",
      "- The shell keeps its working directory and environment for later calls.",
      "- Keep command calls focused and group only related work.",
      "- Use the workspace location supplied in the conversation.",
      "- Check the result before relying on a command's effects.",
      "- Quote paths that contain spaces.",
    ].join("\n")
    const sections = [
      options.readToolName === undefined ? undefined : "Use " + options.readToolName + " to read and search files.",
      options.enableTerminalFiles === true ? "Complete output is stored in a terminal file." : undefined,
      outputNotificationSection,
      options.enableTmuxGuidance === true
        ? getTmuxBackedShellSessionsSectionText({
          ...(options.tmuxSharedSessionName === undefined ? {} : { sharedSessionName: options.tmuxSharedSessionName }),
        })
        : undefined,
    ].filter((section): section is string => section !== undefined)
    return appendSections(minimalDescription, sections)
  }

  if (profile === SlateShellPromptProfile.STREAMING) {
    const base = "Run a shell command and wait for output for the configured block_until_ms duration."
    const withNotifications = outputNotificationSection === undefined
      ? base
      : base + "\n\n" + outputNotificationSection
    if (options.enableTmuxGuidance !== true) {
      const sandboxSection = commonSections.find((section) => /sandbox/i.test(section))
      return sandboxSection === undefined ? withNotifications : withNotifications + "\n" + sandboxSection
    }
    return appendCommon(withNotifications)
  }

  if (profile === SlateShellPromptProfile.SESSION) {
    let base = BASE_DESCRIPTION_SESSION
    if (options.enableBlockUntilMs === true) {
      const defaultText = options.requireBlockUntilMs === true
        ? ""
        : " (default " + formatBlockUntilDefaultForDescription(options.defaultBlockUntilMs ?? 30_000) + ")"
      const outputBullet = outputNotificationSection === undefined ? "" : "\n- " + outputNotificationSection
      base += "\n\nManaging commands that outlast the wait:\n" +
        "- Commands still running after block_until_ms" + defaultText + " continue in the background, with output in a terminal record.\n" +
        "- Set block_until_ms to 0 to start in the background immediately.\n" +
        "- Choose a wait longer than the expected runtime and include startup time.\n" +
        backgroundMonitoringGuidance(options).map((line) => "- " + line).join("\n") +
        outputBullet
    } else if (outputNotificationSection !== undefined) {
      base += "\n\n" + outputNotificationSection
    }
    return appendCommon(base)
  }

  const base = outputNotificationSection === undefined
    ? BASE_DESCRIPTION_INITIAL
    : BASE_DESCRIPTION_INITIAL + "\n\n" + outputNotificationSection
  return appendCommon(base)
}

export function getShellToolParametersSchema(
  sandboxEnabled: boolean,
  profile: SlateShellPromptProfile,
  options: ShellToolDescriptionOptions & { readonly strictArgParsing?: boolean } = {},
): z.ZodObject<z.ZodRawShape> {
  const addOptionalParameters = (schema: z.ZodObject<z.ZodRawShape>): z.ZodObject<z.ZodRawShape> => {
    let nextSchema = schema
    if (options.enableJobProgressNotifications === true) {
      nextSchema = nextSchema.extend({ notify_on_output: notifyOnOutputSchema })
    }
    if (sandboxEnabled) {
      nextSchema = nextSchema.extend({
        required_permissions: getRequiredPermissionsSchema({
          isReadonly: options.isReadonly === true,
          strict: options.strictArgParsing === true,
        }),
      })
    }
    return nextSchema
  }

  if (profile === SlateShellPromptProfile.SESSION || profile === SlateShellPromptProfile.STREAMING) {
    if (options.enableBlockUntilMs === true) {
      const blockUntilSchema = profile === SlateShellPromptProfile.STREAMING && options.requireBlockUntilMs !== true
        ? parametersSchemaWithWaitExample
        : options.requireBlockUntilMs === true
          ? parametersSchemaWithBlockUntilRequired
          : parametersSchemaWithBlockUntilOptional(options.defaultBlockUntilMs ?? 30_000)
      return addOptionalParameters(blockUntilSchema)
    }
    return addOptionalParameters(parametersSchemaSession)
  }
  return addOptionalParameters(parametersSchemaInitial)
}

export { notifyOnOutputSchema }
