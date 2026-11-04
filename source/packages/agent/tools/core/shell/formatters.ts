/**
 * What a shell command's result says when it comes back to the model.
 *
 * A command can end in more ways than one, and each has to be told apart: it finished, it was aborted, it
 * timed out, it was moved to the background because it outlived its block-until duration, the user
 * backgrounded it, the platform backgrounded it when the user interrupted, it could not be spawned at all,
 * or the stream closed without an exit status. The wording of each is the difference between a model that
 * waits, a model that re-runs with a permission, and a model that assumes a command succeeded when it did
 * not.
 *
 * Two reminders are worth more than their length. A sandboxed failure is usually not explained by the
 * program that hit it, so the result says what the sandbox allowed and which permission would lift the
 * restriction — while telling the model not to ask for one needlessly. And a missing exit status is
 * reported as unknown rather than as success, because a command whose outcome is unknown must not be
 * treated as having run.
 *
 * Output is capped from both ends: the start says how the command began and the end says what it last did.
 * A command that was backgrounded reports where its output keeps going, and the shell id is explicitly not
 * for the user — it is an internal handle.
 */

import { ASK_MODE_MODEL_ERROR, truncateOutput } from "../../tool-support.ts"
import { buildToolCallExecutionTimedOutMessage } from "../../tool-execution-timeout.ts"
import { analyzeFailure } from "./retry-helpers.ts"

const SHELL_CHAR_HARD_LIMIT = 20_000
const SHELL_MISSING_EXIT_ERROR_MESSAGE = "Shell output ended without an exit code. Treat the command outcome as unknown; do not assume it succeeded. If this keeps happening, restart the execution environment."

export interface ShellOutputLocation {
  readonly filePath: string
  readonly sizeBytes: number | string | bigint
  readonly lineCount: number | string | bigint
}

export type ShellSandboxMode = "unrestricted" | "workspace-readonly" | "workspace-readwrite" | "unspecified"
export type ShellAbortDisposition = "user" | "timeout"
export type ShellBackgroundDisposition = "user-request" | "timeout"

export interface ShellSandboxProfile {
  readonly mode: ShellSandboxMode
  readonly allowlistEscalated?: boolean | undefined
  readonly networkAccess?: boolean | undefined
  readonly networkPolicy?: { readonly allow?: readonly string[] | undefined } | undefined
}

interface ShellResult {
  readonly combinedOutput: string
  readonly exitCode: number
  readonly executionTimeMs?: number | undefined
  readonly outputLocation?: ShellOutputLocation | undefined
  readonly signal?: string | undefined
  readonly workingDirectory?: string | undefined
  readonly sandboxPolicy?: ShellSandboxProfile | undefined
  readonly command?: string | undefined
  readonly useMinimalHarness?: boolean | undefined
}

export interface ShellFormatterOptions {
  readonly discourageAwait?: boolean | undefined
  readonly autoBackgroundedForInterruption?: boolean | undefined
  readonly promptVersion?: string | undefined
  readonly sandboxPromptEnabled?: boolean | undefined
  readonly useMinimalHarness?: boolean | undefined
}

function makeCompletionNotice(isAborted: boolean, executionTimeMs?: number): string {
  if (isAborted) {
    return executionTimeMs !== undefined ? `The command stopped after ${executionTimeMs} ms.` : "The command stopped."
  }
  return executionTimeMs !== undefined ? `The command finished in ${executionTimeMs} ms.` : "The command finished."
}

function describeFollowingShell(signal?: string, workingDirectory?: string): string {
  // An aborted shell no longer exists; the next call starts from the project root.
  if (signal === "SIGTERM") {
    return "The previous shell ended. Its state is gone, so the next call will open a new shell at the project root."
  }
  let message = "This shell keeps its working directory and environment between calls."
  if (workingDirectory?.trim()) message += ` Current directory: ${workingDirectory}`
  return message
}

function renderCompactCommandOutcome(result: ShellResult): string {
  const sizeAndLines = (location: ShellOutputLocation): { sizeString: string; lineCount: number } => {
    const totalSize = Number(location.sizeBytes)
    return {
      sizeString: totalSize >= 1024 ? `${(totalSize / 1024).toFixed(1)} KB` : `${totalSize} bytes`,
      lineCount: Number(location.lineCount),
    }
  }
  let formatted = `Exit code: ${result.exitCode}\n`
  if (result.executionTimeMs !== undefined) formatted += `Runtime: ${result.executionTimeMs} ms\n`
  if (result.outputLocation) {
    const { sizeString, lineCount } = sizeAndLines(result.outputLocation)
    return `${formatted}Output saved at: ${result.outputLocation.filePath} (${sizeString}, ${lineCount} lines)`
  }
  return `${formatted}Output:\n${truncateOutput(result.combinedOutput, SHELL_CHAR_HARD_LIMIT, true).output}`
}

/** What the sandbox allowed, and — when the command failed in a way the sandbox explains — what to do. */
function explainSandboxBoundaries(
  exitCode: number,
  output: string,
  sandboxPolicy?: ShellSandboxProfile,
  command?: string,
): string {
  if (!sandboxPolicy) return ""
  if (sandboxPolicy.mode === "unrestricted") {
    if (sandboxPolicy.allowlistEscalated) {
      return "\n\nThis command ran outside isolation because an approved command rule allowed it."
    }
    return ""
  }
  const isReadonly = sandboxPolicy.mode === "workspace-readonly"
  const hasNetworkAllowlist = sandboxPolicy.networkAccess === true &&
    sandboxPolicy.networkPolicy?.allow !== undefined &&
    sandboxPolicy.networkPolicy.allow.length > 0
  let result = "\n\nExecution isolation applied these limits:"
  if (isReadonly) {
    result += "\n- Filesystem writes are blocked"
  } else if (sandboxPolicy.mode === "workspace-readwrite") {
    result += "\n- Filesystem writes stay within the workspace; reads may reach other paths"
  }
  if (sandboxPolicy.networkAccess !== undefined) {
    if (sandboxPolicy.networkAccess) {
      result += hasNetworkAllowlist ? "\n- Network access is limited to the configured allowlist" : "\n- Network access is available without an allowlist"
    } else {
      result += "\n- Network access is blocked"
    }
  }
  const hasNetworkRestriction = sandboxPolicy.networkAccess !== true || hasNetworkAllowlist
  const commandFailed = exitCode !== 0
  const failureKind = commandFailed ? analyzeFailure(exitCode, output, command) : undefined
  if (commandFailed && failureKind === "sandbox" && !isReadonly) {
    result += "\n\nThis looks like a filesystem denial. Retry with required_permissions: [\"all\"] to run without isolation; do not ask for permission when the retry is clear."
  } else if (commandFailed && failureKind === "network") {
    result += "\n\nThis looks like a network denial. Retry with required_permissions: [\"full_network\"] to enable network access; do not ask for permission when the retry is clear."
  } else if (!isReadonly) {
    const missingPermissions: string[] = []
    if (hasNetworkRestriction) missingPermissions.push('"full_network"')
    if (missingPermissions.length > 0) {
      result += `\nIf isolation caused the failure, retry with the permission you need (such as [${missingPermissions[0]}]) or with required_permissions: ["all"] to run without isolation. Do not ask for permission when the retry is clear.`
    } else {
      result += "\nIf isolation caused the failure, retry with required_permissions: [\"all\"] to run without isolation. Do not ask for permission when the retry is clear."
    }
  }
  return result
}

function renderDetailedCommandOutcome(result: ShellResult): string {
  if (result.useMinimalHarness) return renderCompactCommandOutcome(result)
  const isAborted = result.signal === "SIGTERM"
  if (result.outputLocation) {
    const totalSize = Number(result.outputLocation.sizeBytes)
    const lineCount = Number(result.outputLocation.lineCount)
    const sizeString = totalSize >= 1024 ? `${(totalSize / 1024).toFixed(1)} KB` : `${totalSize} bytes`
    let formatted = `Exit code: ${result.exitCode}\n\n`
    formatted += `Saved command output: ${result.outputLocation.filePath} (${sizeString}, ${lineCount} lines)\n\n`
    formatted += `${makeCompletionNotice(isAborted, result.executionTimeMs)}\n\n`
    formatted += describeFollowingShell(result.signal, result.workingDirectory)
    return formatted + explainSandboxBoundaries(result.exitCode, result.combinedOutput, result.sandboxPolicy, result.command)
  }
  const combinedResult = truncateOutput(result.combinedOutput, SHELL_CHAR_HARD_LIMIT, true)
  let formatted = `Exit code: ${result.exitCode}\n\n`
  formatted += `Captured output${combinedResult.truncated ? ` (limited to ${SHELL_CHAR_HARD_LIMIT} characters)` : ""}:\n\n`
  formatted += `\`\`\`\n${combinedResult.output}\n\`\`\`\n\n`
  formatted += `${makeCompletionNotice(isAborted, result.executionTimeMs)}\n\n`
  formatted += describeFollowingShell(result.signal, result.workingDirectory)
  return formatted + explainSandboxBoundaries(result.exitCode, result.combinedOutput, result.sandboxPolicy, result.command)
}

export function formatShellResult(result: ShellResult): string {
  return renderDetailedCommandOutcome(result)
}

function renderTimeoutOutcome(partialOutput: string, command: string): string {
  const truncatedOutput = truncateOutput(partialOutput, SHELL_CHAR_HARD_LIMIT, true)
  let formatted = "The command reached its time limit.\n\n"
  if (partialOutput.length > 0) {
    formatted += `Output captured before the time limit${truncatedOutput.truncated ? ` (limited to ${SHELL_CHAR_HARD_LIMIT} characters)` : ""}:\n\n`
    formatted += `\`\`\`\n${truncatedOutput.output}\n\`\`\`\n\n`
  }
  formatted += `The command "${command}" did not finish before the deadline, and its shell was stopped.\n\n`
  return `${formatted}The next call will open a new shell at the project root.`
}

export function formatShellPartialOutputSection(
  partialOutput: string,
  options: { readonly heading: string; readonly truncatedSuffix?: string; readonly emptyMessage?: string },
): string {
  if (partialOutput.length === 0) return options.emptyMessage ?? ""
  const truncatedOutput = truncateOutput(partialOutput, SHELL_CHAR_HARD_LIMIT, true)
  return `${options.heading}${truncatedOutput.truncated ? options.truncatedSuffix ?? " (truncated)" : ""}:\n\n\`\`\`\n${truncatedOutput.output}\n\`\`\``
}

export function formatShellMissingExitDisplay(interleavedOutput: string): string {
  const partialSection = formatShellPartialOutputSection(interleavedOutput, {
    heading: "Output collected before the stream closed",
    truncatedSuffix: ` (truncated to ${SHELL_CHAR_HARD_LIMIT} characters)`,
  })
  return partialSection.length === 0
    ? SHELL_MISSING_EXIT_ERROR_MESSAGE
    : `${SHELL_MISSING_EXIT_ERROR_MESSAGE}\n\n${partialSection}`
}

function userMovedCommandToBackground(
  toolNoun: string,
  elapsedMs?: number,
  options?: { readonly discourageAwait?: boolean | undefined },
): string {
  const elapsedText = elapsedMs !== undefined ? ` after ${elapsedMs}ms` : ""
  const awaitGuidance = options?.discourageAwait === true
    ? " Do NOT await it; either continue with other work or end your turn."
    : ""
  return `The user moved the ${toolNoun} to the background${elapsedText}.${awaitGuidance}`
}

function interruptionMovedCommandToBackground(toolNoun: string, elapsedMs?: number): string {
  const elapsedText = elapsedMs !== undefined ? ` after ${elapsedMs}ms` : ""
  return `The ${toolNoun} moved to the background${elapsedText} when the user interrupted. Stop the command if it should not keep running.`
}

function renderBackgroundContinuation(
  partialOutput: string,
  shellId: number,
  outputPath: string,
  pid?: number,
  msToWait?: number,
  backgroundReason?: ShellBackgroundDisposition,
  options?: ShellFormatterOptions,
): string {
  if (msToWait !== undefined) {
    const intro = backgroundReason === "user-request"
      ? `${options?.autoBackgroundedForInterruption === true ? interruptionMovedCommandToBackground("command", msToWait) : userMovedCommandToBackground("command", msToWait, options)}\n`
      : `The command was still running after ${msToWait}ms, so it continues in the background.\n`
    let formatted = `${intro}Internal shell handle: ${shellId}\n`
    if (pid !== undefined && pid !== 0) formatted += `Process ID: ${pid}\n`
    formatted += `Further output is being written to ${outputPath}. Do not show the internal shell handle to the user.\n\n`
    return formatted + formatShellPartialOutputSection(partialOutput, {
      heading: "Output captured before backgrounding",
      truncatedSuffix: " (truncated)",
      emptyMessage: "No output was collected before backgrounding.",
    })
  }
  let formatted = "The command outlived block_until_ms and is continuing in the background.\n\n"
  const partialSection = formatShellPartialOutputSection(partialOutput, {
    heading: "Output captured before backgrounding",
    truncatedSuffix: ` (truncated to ${SHELL_CHAR_HARD_LIMIT} characters)`,
    emptyMessage: "No output before backgrounding.",
  })
  if (partialSection.length > 0) formatted += `${partialSection}\n\n`
  formatted += `Internal shell handle: ${shellId}\n`
  if (pid !== undefined && pid !== 0) formatted += `Process ID: ${pid}\n`
  return `${formatted}Output continues at ${outputPath}. Do not show the internal shell handle to the user.`
}

function renderToolExecutionTimeout(timeout: { readonly timeoutMs: number; readonly command: string }): string {
  const message = buildToolCallExecutionTimedOutMessage({ toolName: "shell", executionTimeoutMs: timeout.timeoutMs })
  return timeout.command.length > 0 ? `${message}\n\nCommand: ${timeout.command}` : message
}

export interface ShellRenderValue {
  readonly command: string
  readonly interleavedOutput?: string
  readonly stderr?: string
  readonly stdout?: string
  readonly error?: string
  readonly reason?: string
  readonly isReadonly?: boolean
  readonly timeoutMs?: number
  readonly shellId?: number
  readonly pid?: number
  readonly msToWait?: number
  readonly backgroundReason?: ShellBackgroundDisposition
  readonly exitCode?: number
  readonly signal?: string
  readonly workingDirectory?: string
  readonly outputLocation?: ShellOutputLocation
  readonly localExecutionTimeMs?: number
  readonly executionTime?: number
  readonly abortReason?: ShellAbortDisposition
  readonly aborted?: boolean
}

export interface ShellRenderCase {
  readonly case?: string
  readonly value: ShellRenderValue
}

export interface RenderShellResult {
  readonly result: ShellRenderCase
  readonly sandboxPolicy?: ShellSandboxProfile
  readonly isBackground?: boolean
  readonly terminalsFolder?: string
}

export function renderShellResultToString(shellResult: RenderShellResult, options: ShellFormatterOptions = {}): string {
  const { result, sandboxPolicy, isBackground, terminalsFolder } = shellResult
  const terminalFilePath = (shellId: number): string =>
    terminalsFolder ? `${terminalsFolder}/${shellId}.txt` : `<terminals_folder>/${shellId}.txt`

  if (isBackground) {
    switch (result.case) {
      case "success": {
        const shellId = result.value.shellId
        const pid = result.value.pid
        let message = `A background command has started.\nInternal shell handle: ${shellId}\n`
        if (pid !== undefined && pid !== 0) message += `Process ID: ${pid}\n`
        return `${message}Command: ${result.value.command}\nOutput goes to ${terminalFilePath(shellId as number)}. Do not show the internal shell handle to the user.`
      }
      case "failure":
        return result.value.stderr || result.value.stdout || ""
      case "rejected":
        return "The user declined the background command"
      case "permissionDenied":
        return result.value.isReadonly ? ASK_MODE_MODEL_ERROR : `Permission denied: ${result.value.error}`
      case "timeout":
        return renderToolExecutionTimeout({ timeoutMs: result.value.timeoutMs ?? 0, command: result.value.command })
      case "spawnError": {
        const error = result.value.error ?? ""
        if (error.startsWith(SHELL_MISSING_EXIT_ERROR_MESSAGE)) return error
        return result.value.command.length > 0
          ? `Could not start command: ${error}\n\nCommand: ${result.value.command}`
          : `Could not start command: ${error}`
      }
      case undefined:
        return "Unknown error"
      default:
        throw new Error(`Unsupported shell result: ${result.case}`)
    }
  }

  switch (result.case) {
    case "success":
    case "failure": {
      const value = result.value
      const isSuccess = result.case === "success"
      const shellId = isSuccess ? value.shellId : undefined
      const interleavedOutput = value.interleavedOutput
      // A shell id means the command is still running: its result is where the output is going.
      if (shellId !== undefined && shellId !== 0) {
        return renderBackgroundContinuation(
          interleavedOutput ?? "",
          shellId,
          terminalFilePath(shellId),
          isSuccess ? value.pid : undefined,
          isSuccess ? value.msToWait : undefined,
          isSuccess ? value.backgroundReason : undefined,
          {
            discourageAwait: options.discourageAwait,
            autoBackgroundedForInterruption: options.autoBackgroundedForInterruption,
          },
        )
      }
      const abortReason = isSuccess ? undefined : value.abortReason
      const wasAborted = !isSuccess && value.aborted === true
      if (abortReason === "timeout") return renderTimeoutOutcome(interleavedOutput ?? "", value.command)
      const wasUserAborted = abortReason === "user" || (wasAborted && abortReason === undefined)
      const formatted = options.promptVersion === "dsv3-1018"
        ? formatShellResultForVersion({
          combinedOutput: interleavedOutput ?? "",
          exitCode: value.exitCode ?? 0,
          command: value.command,
          workingDirectory: value.workingDirectory,
          signal: value.signal,
          sandboxPolicy,
        }, value.command, { includeSandboxReminder: options.sandboxPromptEnabled })
        : formatShellResult({
          combinedOutput: interleavedOutput ?? "",
          exitCode: value.exitCode ?? 0,
          outputLocation: value.outputLocation,
          sandboxPolicy,
          command: value.command,
          signal: value.signal,
          workingDirectory: value.workingDirectory,
          executionTimeMs: value.localExecutionTimeMs != null ? value.localExecutionTimeMs : value.executionTime,
          useMinimalHarness: options.useMinimalHarness,
        })
      return wasUserAborted ? `The user stopped the command.\n${formatted}` : formatted
    }
    case "timeout":
      return renderToolExecutionTimeout({ timeoutMs: result.value.timeoutMs ?? 0, command: result.value.command })
    case "spawnError": {
      const error = result.value.error ?? ""
      if (error.startsWith(SHELL_MISSING_EXIT_ERROR_MESSAGE)) return error
      return result.value.command.length > 0
        ? `Could not start command: ${error}\n\nCommand: ${result.value.command}`
        : `Could not start command: ${error}`
    }
    case "rejected":
      return `Declined: ${result.value.reason}`
    case "permissionDenied":
      return result.value.isReadonly ? ASK_MODE_MODEL_ERROR : `Permission denied: ${result.value.error}`
    case undefined:
      return "Unknown error"
    default:
      throw new Error(`Unsupported shell result: ${result.case}`)
  }
}

/** The version whose result repeats the command and says what the next call's shell will be. */
export function formatShellResultForVersion(
  result: ShellResult,
  originalCommand: string,
  options?: { readonly includeSandboxReminder?: boolean | undefined },
): string {
  const executedCommand = result.command ?? originalCommand
  const outputWithCommand = `${executedCommand}\n${result.combinedOutput.replace(/\n+$/, "")}`
  const isTruncated = outputWithCommand.length > SHELL_CHAR_HARD_LIMIT
  const displayedOutput = isTruncated ? outputWithCommand.slice(0, SHELL_CHAR_HARD_LIMIT) : outputWithCommand
  let formatted = `Exit code: ${result.exitCode}\n\n`
  formatted += `Captured output${isTruncated ? ` (limited to ${SHELL_CHAR_HARD_LIMIT} characters)` : ""}:\n\n`
  formatted += `\`\`\`\n${displayedOutput}\n\`\`\`\n\n`
  formatted += `The command ${result.signal === "SIGTERM" ? "stopped" : "finished"}.\n\n`
  if (result.signal === "SIGTERM") {
    formatted += "The prior shell ended. Its state is gone, so the next call opens a new shell at the project root."
  } else {
    formatted += "The prior shell remains available for the next call."
    if (result.workingDirectory?.trim()) {
      formatted += `\n\nIts current directory will still be ${result.workingDirectory}.`
    }
  }
  if (options?.includeSandboxReminder) {
    formatted += explainSandboxBoundaries(result.exitCode, result.combinedOutput, result.sandboxPolicy, result.command)
  }
  return formatted
}
