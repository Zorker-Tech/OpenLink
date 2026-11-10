import { McpPermissionDenied, McpResult } from "../proto/generated/agent/v1/mcp_exec_pb.ts"
import type { WriteExecutor, WriteExecutorArgs, WriteExecutorResult } from "../../../packages/agent-exec/write-operation.ts"
import type { DeleteExecutor, DeleteExecutorArgs, DeleteExecutorResult } from "../../../packages/agent-exec/delete.ts"
import type { BackgroundShellExecutor, BackgroundShellExecutorArgs, BackgroundShellExecutorResult } from "../../../packages/agent-exec/background-shell.ts"
import type { ShellExecutor, ShellExecutorArgs, ShellExecResponse } from "../../../packages/agent-exec/shell.ts"
import type { ShellStreamExecutor, ShellStreamExecutorArgs, ShellStreamExecutorEvent } from "../../../packages/agent-exec/shell-stream-operation.ts"
import { permissionDeniedShellEvent } from "../../../packages/local-exec/shell-stream-events.ts"

export interface ReadonlyExecRefusalExecutors {
  readonly shell: ShellExecutor
  readonly shellStream: ShellStreamExecutor
  readonly backgroundShell: BackgroundShellExecutor
  readonly write: WriteExecutor
  readonly delete: DeleteExecutor
  readonly mcp: unknown
}

/** Build the generated permission-denied results at the executor boundary. */
export function createReadonlyExecRefusalExecutors(errorMessage: string): ReadonlyExecRefusalExecutors {
  return {
    shell: {
      async execute(_ctx: unknown, args: ShellExecutorArgs): Promise<ShellExecResponse> {
        return {
          outcome: {
            kind: "permission-denied",
            command: args.command ?? "",
            workingDirectory: args.workingDirectory ?? "",
            message: errorMessage,
            isReadonly: true,
          },
        }
      },
    },
    shellStream: {
      async *execute(_ctx: unknown, args: ShellStreamExecutorArgs): AsyncIterable<ShellStreamExecutorEvent> {
        yield permissionDeniedShellEvent(args.command, args.workingDirectory ?? "", true, errorMessage)
      },
    },
    backgroundShell: {
      async execute(_ctx: unknown, args: BackgroundShellExecutorArgs): Promise<BackgroundShellExecutorResult> {
        return {
          kind: "permission-denied",
          command: args.command,
          workingDirectory: args.workingDirectory ?? "",
          message: errorMessage,
          isReadonly: true,
        }
      },
    },
    write: {
      async execute(_ctx: unknown, args: WriteExecutorArgs): Promise<WriteExecutorResult> {
        return {
          kind: "permission-denied",
          path: args.path,
          directory: "",
          operation: "",
          message: errorMessage,
          isReadonly: true,
        }
      },
    },
    delete: {
      async execute(_ctx: unknown, args: DeleteExecutorArgs): Promise<DeleteExecutorResult> {
        return { kind: "permission-denied", path: args.path, message: errorMessage, isReadonly: true }
      },
    },
    mcp: {
      async execute(_ctx: unknown, args: { readonly name: string }): Promise<McpResult> {
        return new McpResult({
          result: {
            case: "permissionDenied",
            value: new McpPermissionDenied({ error: `${errorMessage} Tool: ${args.name}`, isReadonly: true }),
          },
        })
      },
    },
  }
}
