import type { ShellExecResult } from "../../packages/agent-exec/shell.ts"
import {
  BoxShellSignalKilledError,
  BoxShellTransientError,
  BoxShellUnavailableError,
} from "./box-file-transfer-contracts.ts"

export function isSignalKillFailure(exitCode: number, signal: string): boolean {
  return signal.length > 0 || exitCode < 0
}

export function shellSingleQuote(value: string): string {
  return `'${value.replaceAll("'", `'\\''`)}'`
}

export function describeShellFailure(result: ShellExecResult): string {
  switch (result.case) {
    case "failure": {
      const { exitCode, signal, stderr, aborted } = result.value
      const reason = exitCode < 0 || signal
        ? `killed by signal ${signal || "(unknown)"}${aborted ? " (aborted)" : ""}`
        : `exit ${exitCode}${aborted ? " (aborted)" : ""}`
      return stderr ? `${reason}: ${stderr}` : reason
    }
    case "spawnError":
      return `exec-daemon spawn error: ${result.value.error}`
    case "permissionDenied":
      return `permission denied: ${result.value.error}`
    case "rejected":
      return `exec-daemon rejected the command: ${result.value.reason}`
    case "timeout":
      return `exec-daemon timed out after ${result.value.timeoutMs}ms`
    default:
      return result.case ?? "unknown (no result from exec-daemon)"
  }
}

export function asTransientBoxShellError(
  result: ShellExecResult,
  context: string,
): BoxShellTransientError | undefined {
  switch (result.case) {
    case "failure":
      return isSignalKillFailure(result.value.exitCode, result.value.signal)
        ? new BoxShellSignalKilledError(`${context} signal-killed (${describeShellFailure(result)})`)
        : undefined
    case "spawnError":
    case "timeout":
    case "rejected":
      return new BoxShellUnavailableError(`${context} (${describeShellFailure(result)})`)
    default:
      return undefined
  }
}
