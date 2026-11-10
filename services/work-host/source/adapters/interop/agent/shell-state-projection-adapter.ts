/** Projects Slate shell state into the generated shell messages the runner consumes. */
import { ShellCommand, ShellOutput } from "../proto/generated/agent/v1/agent_pb.ts"
import { PrivacyCapability } from "../../../packages/redaction/classification.ts"
import { RedactedString } from "../../../packages/redaction/redacted-values.ts"
import type {
  SlateStoredShellInvocation,
  SlateStoredShellResult,
} from "../../../packages/agent/shell-state.ts"

function rawText(value: string | RedactedString): string {
  if (value instanceof RedactedString) return value.unwrap(PrivacyCapability.UNSAFE_ALWAYS_ALLOWED)
  if (typeof value === "string") return value
  throw new TypeError("Slate shell text is invalid")
}

export function shellInvocationToRunner(value: SlateStoredShellInvocation): ShellCommand {
  return new ShellCommand({ command: rawText(value.commandText) })
}

export function shellResultToRunner(value: SlateStoredShellResult): ShellOutput {
  return new ShellOutput({
    stdout: rawText(value.standardOutput),
    stderr: rawText(value.standardError),
    exitCode: value.exitCode,
  })
}
