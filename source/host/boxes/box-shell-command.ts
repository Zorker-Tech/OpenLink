/** Slate-owned fields needed to execute a host-originated command in a box. */
import type { ShellCommandParsing, ShellExecutorArgs } from "../../packages/agent-exec/shell.ts";

export interface HostShellArgsInput {
  command: string
  name: string
  workingDirectory: string
  toolCallId: string
}

/** Builds the Slate shell request for host-owned box operations. */
export function buildHostShellArgs(input: HostShellArgsInput): ShellExecutorArgs {
  const parsing: ShellCommandParsing = {
    failed: false,
    executableCommands: [{ name: input.name, fullText: input.command, arguments: [] }],
    hasRedirects: false,
    hasCommandSubstitution: false,
    redirects: [],
  };
  return {
    command: input.command,
    workingDirectory: input.workingDirectory,
    toolCallId: input.toolCallId,
    simpleCommands: [],
    hasInputRedirect: false,
    hasOutputRedirect: false,
    parsing,
    skipApproval: true,
  };
}
