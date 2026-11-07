import { BackgroundShellSpawnResult } from "../proto/generated/agent/v1/background_shell_exec_pb.ts"
import { McpPermissionDenied, McpResult } from "../proto/generated/agent/v1/mcp_exec_pb.ts"
import { ShellPermissionDenied, ShellResult, ShellStream } from "../proto/generated/agent/v1/shell_exec_pb.ts"
import type { WriteExecutor, WriteExecutorArgs, WriteExecutorResult } from "../../../packages/agent-exec/write-operation.ts"
import type { DeleteExecutor, DeleteExecutorArgs, DeleteExecutorResult } from "../../../packages/agent-exec/delete.ts"

interface ShellInput {
  readonly command?: string
  readonly workingDirectory?: string
}

function shellRefusal(error: string, args: ShellInput): ShellPermissionDenied {
  return new ShellPermissionDenied({
    command: args.command ?? "",
    workingDirectory: args.workingDirectory ?? "",
    error,
    isReadonly: true,
  })
}

export interface ReadonlyExecRefusalExecutors {
  readonly shell: unknown
  readonly shellStream: unknown
  readonly backgroundShell: unknown
  readonly write: WriteExecutor
  readonly delete: DeleteExecutor
  readonly mcp: unknown
}

/** Build the generated permission-denied results at the executor boundary. */
export function createReadonlyExecRefusalExecutors(errorMessage: string): ReadonlyExecRefusalExecutors {
  return {
    shell: {
      async execute(_ctx: unknown, args: ShellInput): Promise<ShellResult> {
        return new ShellResult({ result: { case: "permissionDenied", value: shellRefusal(errorMessage, args) } })
      },
    },
    shellStream: {
      async *execute(_ctx: unknown, args: ShellInput): AsyncIterable<ShellStream> {
        yield new ShellStream({ event: { case: "permissionDenied", value: shellRefusal(errorMessage, args) } })
      },
    },
    backgroundShell: {
      async execute(_ctx: unknown, args: ShellInput): Promise<BackgroundShellSpawnResult> {
        return new BackgroundShellSpawnResult({ result: { case: "permissionDenied", value: shellRefusal(errorMessage, args) } })
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
