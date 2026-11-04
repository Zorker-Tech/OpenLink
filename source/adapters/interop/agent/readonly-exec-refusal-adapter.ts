import { BackgroundShellSpawnResult } from "../proto/generated/agent/v1/background_shell_exec_pb.ts"
import { DeletePermissionDenied, DeleteResult } from "../proto/generated/agent/v1/delete_exec_pb.ts"
import { McpPermissionDenied, McpResult } from "../proto/generated/agent/v1/mcp_exec_pb.ts"
import { ShellPermissionDenied, ShellResult, ShellStream } from "../proto/generated/agent/v1/shell_exec_pb.ts"
import { WritePermissionDenied, WriteResult } from "../proto/generated/agent/v1/write_exec_pb.ts"

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
  readonly write: unknown
  readonly delete: unknown
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
      async execute(_ctx: unknown, args: { readonly path: string }): Promise<WriteResult> {
        return new WriteResult({
          result: {
            case: "permissionDenied",
            value: new WritePermissionDenied({ path: args.path, error: errorMessage, isReadonly: true }),
          },
        })
      },
    },
    delete: {
      async execute(_ctx: unknown, args: { readonly path: string }): Promise<DeleteResult> {
        return new DeleteResult({
          result: {
            case: "permissionDenied",
            value: new DeletePermissionDenied({ path: args.path, clientVisibleError: errorMessage, isReadonly: true }),
          },
        })
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
