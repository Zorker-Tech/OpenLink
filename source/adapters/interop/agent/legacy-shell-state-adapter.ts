/** Read-only bridge between historical shell protobuf blobs and Slate shell-turn values. */
import { ShellCommand, ShellOutput } from "../proto/generated/agent/v1/agent_pb.ts"
import {
  toRedactedShellCommand,
  toRedactedShellOutput,
} from "../redacted-protos/generated/agent/v1/agent_redacted.ts"
import { PrivacyCapability } from "../../../packages/redaction/classification.ts"
import type { PrivacyMode } from "../../../packages/redaction/privacy-mode.ts"
import { RedactedString } from "../../../packages/redaction/redacted-values.ts"
import { fromHex, toHex } from "../../../packages/agent-kv/serde.ts"
import type { SlateCheckpointUnknownField } from "../../../packages/agent/conversation-checkpoint-state.ts"
import type {
  SlateShellStateCompatibility,
  SlateStoredShellInvocation,
  SlateStoredShellResult,
} from "../../../packages/agent/shell-state.ts"

type RedactedShellCommand = { readonly command: RedactedString }
type RedactedShellOutput = {
  readonly stdout: RedactedString
  readonly stderr: RedactedString
  readonly exitCode: number
}

function rawText(value: string | RedactedString): string {
  if (value instanceof RedactedString) return value.unwrap(PrivacyCapability.UNSAFE_ALWAYS_ALLOWED)
  if (typeof value === "string") return value
  throw new TypeError("Slate shell text is invalid")
}

function legacyUnknownFields(message: ShellCommand | ShellOutput): SlateCheckpointUnknownField[] {
  return message.getType().runtime.bin.listUnknownFields(message).map(field => ({
    path: [],
    number: field.no,
    wireType: field.wireType,
    dataHex: toHex(field.data),
  }))
}

function compatibility(fields: readonly SlateCheckpointUnknownField[]): SlateShellStateCompatibility | undefined {
  if (fields.length === 0) return undefined
  return {
    legacyUnknownFields: fields.map(field => ({ ...field, path: field.path.map(step => ({ ...step })) })),
  }
}

export function importLegacyShellInvocation(
  bytes: Uint8Array,
  privacyMode: PrivacyMode,
): SlateStoredShellInvocation {
  const message = ShellCommand.fromBinary(bytes)
  const redacted = toRedactedShellCommand(message, privacyMode) as unknown as RedactedShellCommand
  const unknownFields = legacyUnknownFields(message)
  const legacy = compatibility(unknownFields)
  return {
    commandText: redacted.command,
    ...(legacy === undefined ? {} : { compatibility: legacy }),
  }
}

export function importLegacyShellResult(
  bytes: Uint8Array,
  privacyMode: PrivacyMode,
): SlateStoredShellResult {
  const message = ShellOutput.fromBinary(bytes)
  const redacted = toRedactedShellOutput(message, privacyMode) as unknown as RedactedShellOutput
  const unknownFields = legacyUnknownFields(message)
  const legacy = compatibility(unknownFields)
  return {
    standardOutput: redacted.stdout,
    standardError: redacted.stderr,
    exitCode: redacted.exitCode,
    ...(legacy === undefined ? {} : { compatibility: legacy }),
  }
}

function restoreUnknownFields(message: ShellCommand | ShellOutput, fields: readonly SlateCheckpointUnknownField[] | undefined): void {
  for (const field of fields ?? []) {
    if (field.path.length !== 0 || !Number.isInteger(field.number) || field.number < 1 ||
        !Number.isInteger(field.wireType) || field.wireType < 0 || field.wireType > 5 ||
        !/^(?:[0-9a-f]{2})*$/.test(field.dataHex)) {
      throw new TypeError("Slate shell legacy-field metadata is invalid")
    }
    message.getType().runtime.bin.onUnknownField(
      message,
      field.number,
      field.wireType as Parameters<typeof ShellCommand.runtime.bin.onUnknownField>[2],
      fromHex(field.dataHex),
    )
  }
}

export function shellInvocationToRunner(value: SlateStoredShellInvocation): ShellCommand {
  const command = new ShellCommand({ command: rawText(value.commandText) })
  restoreUnknownFields(command, value.compatibility?.legacyUnknownFields)
  return command
}

export function shellResultToRunner(value: SlateStoredShellResult): ShellOutput {
  const output = new ShellOutput({
    stdout: rawText(value.standardOutput),
    stderr: rawText(value.standardError),
    exitCode: value.exitCode,
  })
  restoreUnknownFields(output, value.compatibility?.legacyUnknownFields)
  return output
}
