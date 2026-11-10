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
  switch (result.kind) {
    case "failure": {
      const { exitCode, signal, stderr, aborted } = result
      const reason = exitCode < 0 || signal
        ? `killed by signal ${signal || "(unknown)"}${aborted ? " (aborted)" : ""}`
        : `exit ${exitCode}${aborted ? " (aborted)" : ""}`
      return stderr ? `${reason}: ${stderr}` : reason
    }
    case "spawn-error":
      return `exec-daemon spawn error: ${result.message}`
    case "permission-denied":
      return `permission denied: ${result.message}`
    case "rejected":
      return `exec-daemon rejected the command: ${result.reason}`
    case "timeout":
      return `exec-daemon timed out after ${result.timeoutMs}ms`
    default:
      return "unknown (no result from exec-daemon)"
  }
}

export function asTransientBoxShellError(
  result: ShellExecResult,
  context: string,
): BoxShellTransientError | undefined {
  switch (result.kind) {
    case "failure":
      return isSignalKillFailure(result.exitCode, result.signal)
        ? new BoxShellSignalKilledError(`${context} signal-killed (${describeShellFailure(result)})`)
        : undefined
    case "spawn-error":
    case "timeout":
    case "rejected":
      return new BoxShellUnavailableError(`${context} (${describeShellFailure(result)})`)
    default:
      return undefined
  }
}
