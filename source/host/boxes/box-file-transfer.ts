import { randomBytes } from "node:crypto"
import { posix } from "node:path"

import type { Context } from "../../packages/context/context.ts"
import { shellExecutorResource } from "../../packages/agent-exec/shell.ts"
import { buildHostShellArgs } from "../../adapters/interop/agent/box-shell-command-adapter.ts"
import { writeBoxFileBytesThroughInterop } from "../../adapters/interop/agent/box-file-write-adapter.ts"
import {
  BoxFileTransferError,
  TRANSFER_TOOL_CALL_ID,
  type FileTransferAccessor,
} from "./box-file-transfer-contracts.ts"
import {
  asTransientBoxShellError,
  describeShellFailure,
  shellSingleQuote,
} from "./box-shell-failure-policy.ts"

export {
  BoxFileTransferError,
  BoxShellSignalKilledError,
  BoxShellTransientError,
  BoxShellUnavailableError,
  TRANSFER_TOOL_CALL_ID,
} from "./box-file-transfer-contracts.ts"
export type { FileTransferAccessor } from "./box-file-transfer-contracts.ts"
export {
  asTransientBoxShellError,
  describeShellFailure,
  isSignalKillFailure,
  shellSingleQuote,
} from "./box-shell-failure-policy.ts"

export async function runBoxShell(
  context: Context,
  accessor: FileTransferAccessor,
  script: string,
): Promise<void> {
  const command = `bash -lc ${shellSingleQuote(script)}`
  const response = await accessor.get(shellExecutorResource).execute(
    context,
    buildHostShellArgs({
      command,
      name: "bash",
      workingDirectory: "/",
      toolCallId: TRANSFER_TOOL_CALL_ID,
    }),
  )
  const result = response.result
  if (result.case === "success" && result.value.exitCode === 0) return

  const transient = asTransientBoxShellError(result, "box shell command")
  if (transient !== undefined) throw transient
  throw new BoxFileTransferError(`box shell command failed (${describeShellFailure(result)})`)
}

export async function writeFileBytesViaExecDaemon(
  context: Context,
  accessor: FileTransferAccessor,
  boxPath: string,
  bytes: Uint8Array,
): Promise<void> {
  const outcome = await writeBoxFileBytesThroughInterop(
    context,
    accessor,
    boxPath,
    bytes,
    TRANSFER_TOOL_CALL_ID,
  )
  if (outcome.kind === "success") return

  const resultCase = outcome.kind === "other" ? outcome.case : outcome.kind
  const reason = outcome.kind === "error"
    ? outcome.message
    : outcome.kind === "rejected"
      ? outcome.reason
      : outcome.case
  throw new BoxFileTransferError(`upload to box ${boxPath} failed (${resultCase}): ${reason}`)
}

export async function uploadFileViaExecDaemon(
  context: Context,
  accessor: FileTransferAccessor,
  boxPath: string,
  bytes: Uint8Array,
): Promise<void> {
  await runBoxShell(context, accessor, `mkdir -p -- ${shellSingleQuote(posix.dirname(boxPath))}`)
  const temporaryPath = `${boxPath}.slate-${randomBytes(8).toString("hex")}.part`

  try {
    await writeFileBytesViaExecDaemon(context, accessor, temporaryPath, bytes)
  } catch (error) {
    await runBoxShell(context, accessor, `rm -f -- ${shellSingleQuote(temporaryPath)}`).catch(() => {})
    throw error
  }

  await runBoxShell(context, accessor, `mv -f -- ${shellSingleQuote(temporaryPath)} ${shellSingleQuote(boxPath)}`)
}
