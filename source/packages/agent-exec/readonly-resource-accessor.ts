/**
 * The accessor a read-only subagent runs on.
 *
 * A subagent launched read-only may still be told to run a command or edit a file, and the answer has to
 * be an honest refusal rather than a silent no-op or a real write. So the operations that change something
 * — writing, deleting, calling an MCP tool, and, when the caller asks for it, running any command at all —
 * are replaced with executors that answer with the permission-denied shape of their own result, carrying
 * the same explanation and the flag that says the refusal was a policy rather than a failure.
 *
 * The refusal is built per operation because each result type has its own way of saying it, and the reason
 * names the read-only launch, since that is what the model has to change to proceed. Everything not
 * replaced is answered by the accessor underneath, so a read-only subagent reads and searches as usual.
 */

import {
  BackgroundShellSpawnResult,
  WriteShellStdinError,
  WriteShellStdinResult,
} from "../proto/generated/agent/v1/background_shell_exec_pb.ts"
import {
  DeletePermissionDenied,
  DeleteResult,
} from "../proto/generated/agent/v1/delete_exec_pb.ts"
import {
  McpPermissionDenied,
  McpResult,
} from "../proto/generated/agent/v1/mcp_exec_pb.ts"
import {
  ShellPermissionDenied,
  ShellResult,
  ShellStream,
} from "../proto/generated/agent/v1/shell_exec_pb.ts"
import {
  WritePermissionDenied,
  WriteResult,
} from "../proto/generated/agent/v1/write_exec_pb.ts"
import {
  backgroundShellExecutorResource,
  writeBackgroundShellInputExecutorResource,
} from "./background-shell.ts"
import { deleteExecutorResource } from "./delete.ts"
import { mcpExecutorResource } from "./mcp-operations.ts"
import type { RemoteExecManager } from "./executor-resources.ts"
import {
  CombinedResourceAccessor,
  type RemoteResource,
  type ResourceAccessor,
} from "./resource-provider.ts"
import { shellExecutorResource } from "./shell.ts"
import { shellStreamExecutorResource } from "./shell-stream-operation.ts"
import { writeExecutorResource } from "./write-operation.ts"

const READONLY_WRITE_ERROR_MESSAGE =
  "This operation is not allowed in readonly mode. The subagent was launched with readonly: true, which restricts write operations."

interface ShellLikeArgs {
  command?: string | undefined
  workingDirectory?: string | undefined
}

function createReadonlyShellPermissionDenied(
  errorMessage: string,
  args: ShellLikeArgs,
): ShellPermissionDenied {
  return new ShellPermissionDenied({
    command: args.command ?? "",
    workingDirectory: args.workingDirectory ?? "",
    error: errorMessage,
    isReadonly: true,
  })
}

function createReadonlyShellExecutor(errorMessage: string) {
  return {
    async execute(_ctx: unknown, args: ShellLikeArgs): Promise<ShellResult> {
      return new ShellResult({
        result: {
          case: "permissionDenied",
          value: createReadonlyShellPermissionDenied(errorMessage, args),
        },
      })
    },
  }
}

function createReadonlyShellStreamExecutor(errorMessage: string) {
  return {
    async *execute(_ctx: unknown, args: ShellLikeArgs): AsyncIterable<ShellStream> {
      yield new ShellStream({
        event: {
          case: "permissionDenied",
          value: createReadonlyShellPermissionDenied(errorMessage, args),
        },
      })
    },
  }
}

function createReadonlyBackgroundShellExecutor(errorMessage: string) {
  return {
    async execute(_ctx: unknown, args: ShellLikeArgs): Promise<BackgroundShellSpawnResult> {
      return new BackgroundShellSpawnResult({
        result: {
          case: "permissionDenied",
          value: createReadonlyShellPermissionDenied(errorMessage, args),
        },
      })
    },
  }
}

function createReadonlyWriteExecutor(errorMessage: string) {
  return {
    async execute(_ctx: unknown, args: { path: string }): Promise<WriteResult> {
      return new WriteResult({
        result: {
          case: "permissionDenied",
          value: new WritePermissionDenied({
            path: args.path,
            error: errorMessage,
            isReadonly: true,
          }),
        },
      })
    },
  }
}

function createReadonlyDeleteExecutor(errorMessage: string) {
  return {
    async execute(_ctx: unknown, args: { path: string }): Promise<DeleteResult> {
      return new DeleteResult({
        result: {
          case: "permissionDenied",
          value: new DeletePermissionDenied({
            path: args.path,
            clientVisibleError: errorMessage,
            isReadonly: true,
          }),
        },
      })
    },
  }
}

/** An MCP tool is refused by name, since which tool was attempted is what the model needs to know. */
function createReadonlyMcpExecutor(errorMessage: string) {
  return {
    async execute(_ctx: unknown, args: { name: string }): Promise<McpResult> {
      return new McpResult({
        result: {
          case: "permissionDenied",
          value: new McpPermissionDenied({
            error: `${errorMessage} Tool: ${args.name}`,
            isReadonly: true,
          }),
        },
      })
    },
  }
}

function createReadonlyWriteBackgroundShellStdinExecutor(errorMessage: string) {
  return {
    async execute(_ctx: unknown, _args: unknown): Promise<WriteShellStdinResult> {
      return new WriteShellStdinResult({
        result: {
          case: "error",
          value: new WriteShellStdinError({ error: errorMessage }),
        },
      })
    },
  }
}

interface ReadonlyResourceEntryArgs {
  errorMessage: string
  wrapShell: boolean
  includeWriteBackgroundShellStdin: boolean
}

function buildReadonlyResourceEntries(
  args: ReadonlyResourceEntryArgs,
): Array<readonly [RemoteResource<unknown, RemoteExecManager>, unknown]> {
  const localEntries: Array<readonly [RemoteResource<unknown, RemoteExecManager>, unknown]> = [
    [writeExecutorResource, createReadonlyWriteExecutor(args.errorMessage)],
    [deleteExecutorResource, createReadonlyDeleteExecutor(args.errorMessage)],
    [mcpExecutorResource, createReadonlyMcpExecutor(args.errorMessage)],
  ]
  // Shells are only wrapped when asked for: a read-only subagent may be allowed to run commands as long as
  // it does not write through them.
  if (args.wrapShell) {
    localEntries.push(
      [shellExecutorResource, createReadonlyShellExecutor(args.errorMessage)],
      [shellStreamExecutorResource, createReadonlyShellStreamExecutor(args.errorMessage)],
      [backgroundShellExecutorResource, createReadonlyBackgroundShellExecutor(args.errorMessage)],
    )
  }
  if (args.includeWriteBackgroundShellStdin) {
    localEntries.push([
      writeBackgroundShellInputExecutorResource,
      createReadonlyWriteBackgroundShellStdinExecutor(args.errorMessage),
    ])
  }
  return localEntries
}

export function createReadonlyResourceAccessor(
  baseAccessor: ResourceAccessor<RemoteExecManager>,
  wrapShell: boolean,
): ResourceAccessor<RemoteExecManager> {
  return new CombinedResourceAccessor(
    baseAccessor,
    buildReadonlyResourceEntries({
      errorMessage: READONLY_WRITE_ERROR_MESSAGE,
      wrapShell,
      includeWriteBackgroundShellStdin: false,
    }),
  )
}
