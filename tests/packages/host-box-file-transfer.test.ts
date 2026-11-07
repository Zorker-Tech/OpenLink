import assert from "node:assert/strict"
import { test } from "node:test"

import { createContext } from "../../source/packages/context/context.ts"
import { shellExecutorResource } from "../../source/packages/agent-exec/shell.ts"
import { writeExecutorResource, type WriteExecutorResult } from "../../source/packages/agent-exec/write-operation.ts"
import {
  asTransientBoxShellError,
  BoxFileTransferError,
  BoxShellSignalKilledError,
  BoxShellUnavailableError,
  describeShellFailure,
  isSignalKillFailure,
  shellSingleQuote,
  TRANSFER_TOOL_CALL_ID,
  uploadFileViaExecDaemon,
} from "../../source/host/boxes/box-file-transfer.ts"
import type { FileTransferAccessor } from "../../source/host/boxes/box-file-transfer.ts"

function fileTransferHarness(options: { shellResult?: unknown; writeResult?: WriteExecutorResult } = {}) {
  const shellCalls: Array<Record<string, unknown>> = []
  const writeCalls: Array<Record<string, unknown>> = []
  const accessor = {
    get(resource: unknown) {
      if (resource === shellExecutorResource) {
        return {
          async execute(_context: unknown, args: unknown) {
            shellCalls.push(args as Record<string, unknown>)
            return options.shellResult ?? { result: { case: "success", value: { exitCode: 0 } } }
          },
        }
      }
      if (resource === writeExecutorResource) {
        return {
          async execute(_context: unknown, args: unknown) {
            writeCalls.push(args as Record<string, unknown>)
            return options.writeResult ?? { kind: "success", path: String((args as { path?: unknown }).path ?? ""), linesWritten: 0, bytesWritten: 0 }
          },
        }
      }
      throw new Error("unexpected executor resource")
    },
  }
  return {
    accessor: accessor as unknown as FileTransferAccessor,
    shellCalls,
    writeCalls,
  }
}

test("shell values are quoted as one argument, including apostrophes", () => {
  assert.equal(shellSingleQuote("folder/in'put.txt"), "'folder/in'\\''put.txt'")
})

test("an upload writes to a temporary file before moving into place", async () => {
  const { accessor, shellCalls, writeCalls } = fileTransferHarness()
  const bytes = new Uint8Array([1, 2, 3])

  await uploadFileViaExecDaemon(createContext(), accessor, "/box/upload.txt", bytes)

  assert.equal(shellCalls.length, 2)
  const temporaryPath = String(writeCalls[0]!.path)
  assert.equal(shellCalls[0]!.command, `bash -lc ${shellSingleQuote("mkdir -p -- '/box'")}`)
  assert.equal(
    shellCalls[1]!.command,
    `bash -lc ${shellSingleQuote(`mv -f -- '${temporaryPath}' '/box/upload.txt'`)}`,
  )
  assert.equal(writeCalls.length, 1)
  assert.match(String(writeCalls[0]!.path), /^\/box\/upload\.txt\.slate-[0-9a-f]{16}\.part$/)
  assert.deepEqual(writeCalls[0]!.bytes, bytes)
  assert.equal(writeCalls[0]!.toolCallId, TRANSFER_TOOL_CALL_ID)
})

test("a failed write removes its temporary file and preserves the write error", async () => {
  const { accessor, shellCalls, writeCalls } = fileTransferHarness({
    writeResult: { kind: "error", path: "/box/upload.txt", error: "permission denied" },
  })

  await assert.rejects(
    uploadFileViaExecDaemon(createContext(), accessor, "/box/upload.txt", new Uint8Array([4])),
    BoxFileTransferError,
  )

  assert.equal(shellCalls.length, 2)
  const temporaryPath = String(writeCalls[0]!.path)
  assert.equal(
    shellCalls[1]!.command,
    `bash -lc ${shellSingleQuote(`rm -f -- '${temporaryPath}'`)}`,
  )
})

test("signal-killed and unavailable shell commands stay retryable", () => {
  const killed = {
    case: "failure",
    value: { exitCode: -1, signal: "SIGTERM", stderr: "stopped", aborted: true },
  } as never
  const timedOut = { case: "timeout", value: { timeoutMs: 500 } } as never

  assert.equal(isSignalKillFailure(-1, ""), true)
  assert.equal(isSignalKillFailure(1, ""), false)
  assert.equal(describeShellFailure(killed), "killed by signal SIGTERM (aborted): stopped")
  assert.ok(asTransientBoxShellError(killed, "copy") instanceof BoxShellSignalKilledError)
  assert.ok(asTransientBoxShellError(timedOut, "copy") instanceof BoxShellUnavailableError)
  assert.equal(asTransientBoxShellError({ case: "permissionDenied", value: { error: "denied" } } as never, "copy"), undefined)
})
