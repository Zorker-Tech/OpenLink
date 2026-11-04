import type { ShellExecutor } from "../../packages/agent-exec/shell.ts"
import { shellExecutorResource } from "../../packages/agent-exec/shell.ts"
import type { WriteExecutor } from "../../packages/agent-exec/write-operation.ts"
import { writeExecutorResource } from "../../packages/agent-exec/write-operation.ts"

export class BoxFileTransferError extends Error {
  override name = "BoxFileTransferError"
}

export class BoxShellTransientError extends Error {
  override name = "BoxShellTransientError"
}

export class BoxShellSignalKilledError extends BoxShellTransientError {
  override name = "BoxShellSignalKilledError"
}

export class BoxShellUnavailableError extends BoxShellTransientError {
  override name = "BoxShellUnavailableError"
}

export const TRANSFER_TOOL_CALL_ID = "slate-box-file-transfer"

export interface FileTransferAccessor {
  get(resource: typeof shellExecutorResource): ShellExecutor
  get(resource: typeof writeExecutorResource): WriteExecutor
}
