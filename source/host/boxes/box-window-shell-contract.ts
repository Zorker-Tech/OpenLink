import type { Context } from "../../packages/context/context.ts"
import {
  shellExecutorResource,
  type ShellExecutor,
} from "../../packages/agent-exec/shell.ts"
import type { HostShellArgsInput } from "./box-shell-command.ts"

export type SlateWindowShellOutcome =
  | {
      readonly kind: "not-completed"
      readonly resultKind: string | undefined
    }
  | {
      readonly kind: "completed"
      readonly exitCode: number
      readonly stderr: string
    }

export interface BoxWindowShellAccessor {
  get(resource: typeof shellExecutorResource): ShellExecutor
}

/** Runs one host-originated command and returns only the state window policy observes. */
export type BoxWindowShellCommandExecutor = (
  ctx: Context,
  accessor: BoxWindowShellAccessor,
  input: HostShellArgsInput,
) => Promise<SlateWindowShellOutcome>
