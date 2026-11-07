import assert from "node:assert/strict"
import { describe, it } from "node:test"

import { ForceBackgroundShellStatus, ShellAbortReason, ShellBackgroundReason, ShellStream, ShellStreamHookContext } from "../../source/adapters/interop/proto/generated/agent/v1/shell_exec_pb.ts"
import { HookAdditionalContext } from "../../source/adapters/interop/proto/generated/agent/v1/hook_additional_context_pb.ts"
import { OutputLocation } from "../../source/adapters/interop/proto/generated/agent/v1/utils_pb.ts"
import { SandboxPolicy, SandboxPolicy_Type } from "../../source/adapters/interop/proto/generated/agent/v1/sandbox_pb.ts"
import { localShellForegroundHandoffToInterop, localShellStreamEventFromInterop, localShellStreamEventToInterop } from "../../source/adapters/interop/agent/local-shell-stream-executor-adapter.ts"
import type { LocalShellStreamEvent } from "../../source/packages/local-exec/shell-stream-events.ts"

function omitUndefined(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(omitUndefined)
  if (typeof value !== "object" || value === null) return value
  return Object.fromEntries(Object.entries(value).filter(([, child]) => child !== undefined).map(([key, child]) => [key, omitUndefined(child)]))
}

describe("the local shell stream interop adapter", () => {
  it("encodes Slate start, output and exit events to the generated stream", () => {
    const start = localShellStreamEventToInterop({ type: "start", policy: { type: "workspace_readwrite" } })
    const stdout = localShellStreamEventToInterop({ type: "stdout", data: "hello" })
    const exit = localShellStreamEventToInterop({
      type: "exit",
      code: 7,
      cwd: "/repo",
      outputLocation: { filePath: "/repo/output.txt", sizeBytes: 5n, lineCount: 1n },
      aborted: false,
      localExecutionTimeMs: 19,
    })

    assert.equal(start instanceof ShellStream, true)
    assert.equal(start.event.case, "start")
    if (start.event.case !== "start") assert.fail("expected a start event")
    assert.equal(start.event.value.sandboxPolicy?.type, SandboxPolicy_Type.WORKSPACE_READWRITE)
    assert.equal(stdout.event.case, "stdout")
    if (stdout.event.case !== "stdout") assert.fail("expected stdout")
    assert.equal(stdout.event.value.data, "hello")
    assert.equal(exit.event.case, "exit")
    if (exit.event.case !== "exit") assert.fail("expected an exit event")
    assert.equal(exit.event.value.code, 7)
    assert.equal(exit.event.value.outputLocation?.filePath, "/repo/output.txt")
  })

  it("encodes foreground handoff status and the accepted run", () => {
    const notFound = localShellForegroundHandoffToInterop({ status: "not_found" })
    assert.equal(notFound.status, ForceBackgroundShellStatus.NOT_FOUND)

    const accepted = localShellForegroundHandoffToInterop({
      status: "accepted",
      shellResult: {
        shellId: 42,
        command: "tail -f output",
        workingDirectory: "/repo",
        msToWait: 250,
        backgroundReason: "user",
        interleavedOutput: "before handoff",
      },
    })
    assert.equal(accepted.status, ForceBackgroundShellStatus.ACCEPTED)
    assert.equal(accepted.shellResult?.result.case, "success")
    if (accepted.shellResult?.result.case !== "success") assert.fail("expected a successful shell result")
    assert.equal(accepted.shellResult.result.value.backgroundReason, ShellBackgroundReason.USER_REQUEST)
    assert.equal(accepted.shellResult.result.value.interleavedOutput, "before handoff")
  })

  it("decodes stream events into Slate fields and retains unknown enum values", () => {
    const denied = localShellStreamEventFromInterop(new ShellStream({
      event: { case: "permissionDenied", value: { command: "rm", workingDirectory: "/repo", error: "blocked", isReadonly: true } },
    }))
    assert.deepEqual(denied, { type: "permissionDenied", command: "rm", workingDirectory: "/repo", message: "blocked", isReadonly: true })

    const started = localShellStreamEventFromInterop(new ShellStream({
      event: { case: "start", value: { sandboxPolicy: new SandboxPolicy({ type: SandboxPolicy_Type.WORKSPACE_READWRITE, networkAccess: false }) } },
    }))
    assert.equal(started.type, "start")
    if (started.type !== "start") assert.fail("expected a start event")
    assert.equal(started.policy?.type, "workspace_readwrite")

    const exited = localShellStreamEventFromInterop(new ShellStream({
      event: { case: "exit", value: {
        code: 143,
        cwd: "/repo",
        outputLocation: new OutputLocation({ filePath: "/repo/out.txt", sizeBytes: 12n, lineCount: 2n }),
        aborted: true,
        abortReason: 91 as ShellAbortReason,
        localExecutionTimeMs: 14,
      } },
    }))
    assert.deepEqual(exited, {
      type: "exit",
      code: 143,
      cwd: "/repo",
      outputLocation: { filePath: "/repo/out.txt", sizeBytes: 12n, lineCount: 2n },
      aborted: true,
      abortReason: { kind: "unknown", code: 91 },
      localExecutionTimeMs: 14,
    })

    const backgrounded = localShellStreamEventFromInterop(new ShellStream({
      event: { case: "backgrounded", value: {
        shellId: 42,
        command: "tail -f out.txt",
        workingDirectory: "/repo",
        pid: 81,
        msToWait: 20,
        reason: 73 as ShellBackgroundReason,
      } },
    }))
    assert.deepEqual(backgrounded, {
      type: "backgrounded",
      shellId: 42,
      command: "tail -f out.txt",
      workingDirectory: "/repo",
      pid: 81,
      elapsedMs: 20,
      reason: { kind: "unknown", code: 73 },
    })

    const hookContext = localShellStreamEventFromInterop(new ShellStream({
      event: { case: "hookContext", value: new ShellStreamHookContext({
        hookAdditionalContexts: [new HookAdditionalContext({ hookEventName: "AfterTool", content: "notice" })],
      }) },
    }))
    assert.deepEqual(hookContext, { type: "hookContext", contexts: [{ event: "AfterTool", text: "notice" }] })
    assert.deepEqual(localShellStreamEventFromInterop(new ShellStream()), { type: "unrecognized" })
  })

  it("round-trips each Slate stream event through the generated transport representation", () => {
    const events: LocalShellStreamEvent[] = [
      { type: "rejected", command: "rm", workingDirectory: "/repo", reason: "blocked" },
      { type: "permissionDenied", command: "rm", workingDirectory: "/repo", isReadonly: true, message: "read only" },
      {
        type: "start",
        policy: {
          type: "workspace_readwrite",
          networkPolicy: { version: 1, default: "deny" },
          additionalReadwritePaths: ["/cache"],
          additionalReadonlyPaths: ["/docs"],
          readBoundary: "workspace",
          additionalReadPaths: ["/repo/shared"],
        },
      },
      { type: "stdout", data: "out" },
      { type: "stderr", data: "err" },
      {
        type: "exit",
        code: 143,
        cwd: "/repo",
        outputLocation: { filePath: "/repo/output.txt", sizeBytes: 6n, lineCount: 2n },
        aborted: true,
        abortReason: "user_abort",
        localExecutionTimeMs: 7,
      },
      { type: "sandboxUnsupported", command: "git status", workingDirectory: "/repo", policyType: "workspace_readonly", reason: "unsupported", readonly: true },
      { type: "backgrounded", shellId: 5, command: "tail -f output.txt", workingDirectory: "/repo", pid: 7, elapsedMs: 11, reason: "timeout" },
      { type: "hookContext", contexts: [{ event: "AfterTool", text: "hook note" }] },
      { type: "unrecognized" },
    ];
    for (const event of events) {
      assert.deepEqual(
        omitUndefined(localShellStreamEventFromInterop(localShellStreamEventToInterop(event))),
        omitUndefined(event),
      );
    }
  })
})
