import assert from "node:assert/strict"
import { test } from "node:test"

import { executeBoxWindowShellCommand } from "../../source/adapters/interop/agent/box-window-shell-result-adapter.ts"
import { createContext } from "../../source/packages/context/context.ts"
import type { ShellExecResponse } from "../../source/packages/agent-exec/shell.ts"
import { SLATE_BOX_PRIMARY_WINDOW_INDEX, SlateBoxNoMonitorAvailableError } from "../../source/host/ports/box.ts"
import {
  BoxWindowError,
  SLATE_BOX_WINDOW_UNAVAILABLE_EXIT_CODE,
  boxWindowKey,
  clearAgentWindowConnections,
  envInt,
  mintSlateWindowOwnerToken,
  primaryBoxWindow,
  runStartWindow,
  runStopWindow,
  runWindowScript,
  touchSlateMonitorBusyLease,
} from "../../source/host/boxes/box-windows.ts"

function shellSuccess(fields: Partial<{ exitCode: number; stderr: string }> = {}): ShellExecResponse {
  return { outcome: { kind: "success", command: "", workingDirectory: "", exitCode: 0, signal: "", stdout: "", stderr: "", executionTimeMs: 0, ...fields } }
}

function shellAccessor(answer: ShellExecResponse | Error, calls: unknown[][] = []) {
  return {
    get: () => ({
      async execute(_context: unknown, args: unknown) {
        calls.push([args])
        if (answer instanceof Error) throw answer
        return answer
      },
    }),
  }
}

test("window scripts leave the primary alone and validate fork ownership before execution", async () => {
  assert.equal(SLATE_BOX_WINDOW_UNAVAILABLE_EXIT_CODE, 75)
  const calls: unknown[][] = []
  const refused: string[] = []
  await runWindowScript(createContext(), shellAccessor({ outcome: { kind: "unrecognized" } }, calls) as never, executeBoxWindowShellCommand as never, "start-window", SLATE_BOX_PRIMARY_WINDOW_INDEX, {
    reportGuardRefused: (stage) => refused.push(stage),
  })
  assert.deepEqual(refused, ["start-window"])
  assert.deepEqual(calls, [])
  await assert.rejects(
    runWindowScript(createContext(), shellAccessor({ outcome: { kind: "unrecognized" } }, calls) as never, executeBoxWindowShellCommand as never, "start-window", 2, { ownerToken: "bad token" }),
    /malformed owner token/,
  )
  assert.deepEqual(calls, [])
})

test("window scripts send the scoped command and distinguish monitor exhaustion from other failures", async () => {
  const calls: unknown[][] = []
  const token = mintSlateWindowOwnerToken()
  await runStartWindow(createContext(), shellAccessor(shellSuccess(), calls) as never, executeBoxWindowShellCommand as never, 2, token)
  const request = calls[0]?.[0] as { command: string; workingDirectory: string; toolCallId: string; parsing?: { executableCommands: Array<{ name: string }> } }
  assert.deepEqual({ command: request.command, name: request.parsing?.executableCommands[0]?.name, cwd: request.workingDirectory, toolCallId: request.toolCallId }, {
    command: `/usr/local/bin/start-window 2 ${token}`,
    name: "start-window",
    cwd: "/workspace",
    toolCallId: "slate-start-window",
  })
  assert.equal(await runStopWindow(createContext(), shellAccessor(shellSuccess()) as never, executeBoxWindowShellCommand as never, 3), undefined)

  const unavailable = shellSuccess({ exitCode: SLATE_BOX_WINDOW_UNAVAILABLE_EXIT_CODE, stderr: "owned" })
  await assert.rejects(runWindowScript(createContext(), shellAccessor(unavailable) as never, executeBoxWindowShellCommand as never, "start-window", 4), SlateBoxNoMonitorAvailableError)
  const failed = shellSuccess({ exitCode: 2, stderr: "bad command" })
  await assert.rejects(runWindowScript(createContext(), shellAccessor(failed) as never, executeBoxWindowShellCommand as never, "start-window", 4), /start-window exited 2: bad command/)
  const rejected: ShellExecResponse = { outcome: { kind: "failure", command: "", workingDirectory: "", exitCode: 1, signal: "", stdout: "", stderr: "", executionTimeMs: 0, aborted: false } }
  await assert.rejects(runWindowScript(createContext(), shellAccessor(rejected) as never, executeBoxWindowShellCommand as never, "stop-window", 4), /stop-window failed \(failure\)/)
})

test("window helper state and busy leases stay scoped to the agent and a positive display", async () => {
  assert.equal(envInt("WINDOW_LIMIT", 100, { WINDOW_LIMIT: " 25 " }), 25)
  assert.equal(envInt("WINDOW_LIMIT", 100, { WINDOW_LIMIT: "0" }), 100)
  assert.equal(envInt("WINDOW_LIMIT", 100, { WINDOW_LIMIT: "oops" }), 100)
  assert.match(mintSlateWindowOwnerToken(), /^[A-Za-z0-9_-]+$/)
  assert.deepEqual(primaryBoxWindow({ remoteAccessor: "access", vncUrl: "vnc" }), {
    windowIndex: SLATE_BOX_PRIMARY_WINDOW_INDEX,
    computerUse: "access",
    vncUrl: "vnc",
  })

  const connections = new Map([["a#2", 2], ["a#3", 3], ["ab#2", 4]])
  assert.equal(boxWindowKey("a", 2), "a#2")
  clearAgentWindowConnections(connections, "a")
  assert.deepEqual([...connections], [["ab#2", 4]])

  const calls: unknown[][] = []
  await touchSlateMonitorBusyLease(createContext(), shellAccessor({ outcome: { kind: "unrecognized" } }, calls) as never, executeBoxWindowShellCommand as never, 0)
  await touchSlateMonitorBusyLease(createContext(), shellAccessor({ outcome: { kind: "unrecognized" } }, calls) as never, executeBoxWindowShellCommand as never, 2)
  assert.equal(calls.length, 1)
  const broken = shellAccessor(new Error("ignored"), calls) as never
  await assert.doesNotReject(touchSlateMonitorBusyLease(createContext(), broken, executeBoxWindowShellCommand as never, 3))
})
