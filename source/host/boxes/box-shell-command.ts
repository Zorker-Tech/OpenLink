/**
 * The arguments a shell command is given when the host runs it on a box.
 *
 * The host runs the command itself rather than asking the user, so the arguments say so, and the parse the platform
 * already did travels with them rather than being done again.
 */
import { ShellArgs, ShellCommandParsingResult, ShellCommandParsingResult_ExecutableCommand } from "../../packages/proto/generated/agent/v1/shell_exec_pb.ts";

export interface HostShellArgsInput { command: string; name: string; workingDirectory: string; toolCallId: string }
export type HostShellArgs = ShellArgs;
export function buildHostShellArgs({ command, name, workingDirectory, toolCallId }: HostShellArgsInput): HostShellArgs { return new ShellArgs({ command, workingDirectory, toolCallId, skipApproval: true, parsingResult: new ShellCommandParsingResult({ parsingFailed: false, executableCommands: [new ShellCommandParsingResult_ExecutableCommand({ name, args: [], fullText: command })], hasRedirects: false, hasCommandSubstitution: false }) }); }
