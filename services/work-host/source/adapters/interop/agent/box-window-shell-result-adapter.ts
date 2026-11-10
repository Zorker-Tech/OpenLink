import {
  shellExecutorResource,
  type ShellExecResponse,
} from "../../../packages/agent-exec/shell.ts"
import type {
  BoxWindowShellCommandExecutor,
  SlateWindowShellOutcome,
} from "../../../host/boxes/box-window-shell-contract.ts"
import { buildHostShellArgs } from "../../../host/boxes/box-shell-command.ts"

/** Project the shell outcome to the fields window policy needs. */
export function projectWindowShellOutcome(result: ShellExecResponse): SlateWindowShellOutcome {
  if (result.outcome.kind !== "success") return { kind: "not-completed", resultKind: result.outcome.kind }
  return { kind: "completed", exitCode: result.outcome.exitCode, stderr: result.outcome.stderr }
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
