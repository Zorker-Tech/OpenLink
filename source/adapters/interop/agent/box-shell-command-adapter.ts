import {
  ShellArgs,
  ShellCommandParsingResult,
  ShellCommandParsingResult_ExecutableCommand,
} from "../proto/generated/agent/v1/shell_exec_pb.ts";
import type { HostShellArgsInput } from "../../../host/boxes/box-shell-command.ts";

export function buildHostShellArgs({
  command,
  name,
  workingDirectory,
  toolCallId,
}: HostShellArgsInput): ShellArgs {
  const parsedCommand = new ShellCommandParsingResult({
    parsingFailed: false,
    executableCommands: [new ShellCommandParsingResult_ExecutableCommand({
      name,
      args: [],
      fullText: command,
    })],
    hasRedirects: false,
    hasCommandSubstitution: false,
  });

  return new ShellArgs({
    command,
    workingDirectory,
    toolCallId,
    skipApproval: true,
    parsingResult: parsedCommand,
  });
}
