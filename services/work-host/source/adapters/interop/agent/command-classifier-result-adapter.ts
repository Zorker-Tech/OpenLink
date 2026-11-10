import {
  CommandClassifierResult,
  CommandClassifierResult_ClassifiedCommand,
  CommandClassifierResult_SuggestedSandboxMode,
} from "../proto/generated/agent/v1/shell_exec_pb.ts"
import type {
  CommandClassifierInternalResult,
  CommandClassifierSucceededResult,
} from "../../../packages/agent/utils/agent-config-contracts.ts"

export function classifierResultToProto(
  result: CommandClassifierInternalResult,
): InstanceType<typeof CommandClassifierResult> {
  if (result.kind !== "classification-succeeded") {
    return new CommandClassifierResult({
      commands: [],
      suggestedSandboxMode: CommandClassifierResult_SuggestedSandboxMode.UNDETERMINED,
      classificationFailed: true,
    })
  }

  const classified = result as CommandClassifierSucceededResult
  const suggestedSandboxMode = (() => {
    switch (classified.suggestedSandboxMode) {
      case "SANDBOX": return CommandClassifierResult_SuggestedSandboxMode.SANDBOX
      case "NO_SANDBOX": return CommandClassifierResult_SuggestedSandboxMode.NO_SANDBOX
      default: return CommandClassifierResult_SuggestedSandboxMode.UNDETERMINED
    }
  })()
  return new CommandClassifierResult({
    commands: classified.commands.map(command => new CommandClassifierResult_ClassifiedCommand({
      name: command.name,
      arguments: command.arguments,
      suggestedAllowlistEntry: command.suggestedAllowlistEntry,
      subcommandTokens: command.subcommandTokens,
    })),
    suggestedSandboxMode,
    classificationFailed: false,
  })
}
