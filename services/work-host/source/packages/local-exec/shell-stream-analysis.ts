/** Converts the shell parser's syntax tree into the policy-facing command description. */
import { analyzeShellCommand } from "../shell-exec/shell-parser.ts";
import type { ShellCommandParsing } from "./shell-stream-contracts.ts";

export function parseShellCommand(command: string): ShellCommandParsing {
  return analyzeShellCommand(command).structured;
}
