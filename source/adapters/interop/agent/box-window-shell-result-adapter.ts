import {
  shellExecutorResource,
  type ShellExecResponse,
} from "../../../packages/agent-exec/shell.ts"
import type {
  BoxWindowShellCommandExecutor,
  SlateWindowShellOutcome,
} from "../../../host/boxes/box-window-shell-contract.ts"
import { buildHostShellArgs } from "./box-shell-command-adapter.ts"

/** Strip the generated oneof so box window policy only consumes a Slate result. */
export function projectWindowShellOutcome(result: ShellExecResponse): SlateWindowShellOutcome {
  if (result.result.case !== "success") return { kind: "not-completed", resultKind: result.result.case }
  return { kind: "completed", exitCode: result.result.value.exitCode, stderr: result.result.value.stderr }
}

export const executeBoxWindowShellCommand: BoxWindowShellCommandExecutor = async (
  context,
  accessor,
  input,
) => {
  const result = await accessor
    .get(shellExecutorResource)
    .execute(context, buildHostShellArgs(input))
  return projectWindowShellOutcome(result)
}
