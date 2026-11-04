import { test } from "node:test"
import assert from "node:assert/strict"

import {
  InputTokenLimitError,
  OutputTokensLimitExceededError,
  ProactiveSummarizationThresholdError,
  createImageResult,
  createStringResult,
} from "../../source/packages/chat-inference/prompt-executor.ts"
import {
  formatShellMissingExitDisplay,
  formatShellPartialOutputSection,
  formatShellResult,
  formatShellResultForVersion,
  renderShellResultToString,
} from "../../source/packages/agent/tools/core/shell/formatters.ts"
import { ASK_MODE_MODEL_ERROR } from "../../source/packages/agent/tools/tool-support.ts"

// ---------------------------------------------------------------------------------------------
// the small prompt-executor helpers
// ---------------------------------------------------------------------------------------------

test("a text result carries its text and its error flag", () => {
  assert.deepEqual(createStringResult("done"), { content: [{ type: "text", text: "done" }], isError: false })
  assert.equal(createStringResult("failed", true).isError, true)
})

test("an image result puts the text before the image", () => {
  const withText = createImageResult("AAAA", "image/png", "here it is")
  assert.deepEqual(withText.content, [
    { type: "text", text: "here it is" },
    { type: "image", data: "AAAA", mimeType: "image/png" },
  ])
  const withoutText = createImageResult("AAAA", "image/png")
  assert.equal(withoutText.content.length, 1)
  assert.equal(withoutText.content[0]?.type, "image")
})

test("the three limits are distinct types with their own names", () => {
  const errors = [
    new OutputTokensLimitExceededError(),
    new InputTokenLimitError(),
    new ProactiveSummarizationThresholdError(),
  ]
  assert.deepEqual(errors.map(error => error.name), [
    "OutputTokensLimitExceededError",
    "InputTokenLimitError",
    "ProactiveSummarizationThresholdError",
  ])
  assert.equal(errors[0]?.message, "Provider exceeded max output tokens")
  assert.equal(errors[1]?.message, "Input token limit exceeded")
  assert.equal(errors[2]?.message, "Configured summarization threshold reached")
  assert.equal(new InputTokenLimitError("custom").message, "custom")
  for (const error of errors) assert.ok(error instanceof Error)
})

// ---------------------------------------------------------------------------------------------
// a finished command
// ---------------------------------------------------------------------------------------------

function shellResult(overrides: Record<string, unknown> = {}) {
  return { combinedOutput: "output", exitCode: 0, ...overrides }
}

test("a finished command reports its exit code, its output and the shell's state", () => {
  const formatted = formatShellResult(shellResult({ executionTimeMs: 120, workingDirectory: "/p" }))
  assert.match(formatted, /^Exit code: 0\n\nCaptured output:\n\n```\noutput\n```/)
  assert.match(formatted, /The command finished in 120 ms\./)
  assert.match(formatted, /keeps its working directory and environment between calls/)
  assert.match(formatted, /Current directory: \/p/)
})

test("an aborted command says the next call starts a new shell", () => {
  const formatted = formatShellResult(shellResult({ signal: "SIGTERM" }))
  assert.match(formatted, /The command stopped\./)
  assert.match(formatted, /new shell at the project root/)
})

test("a truncated command output says how much was kept", () => {
  const formatted = formatShellResult(shellResult({ combinedOutput: "x".repeat(30_000) }))
  assert.match(formatted, /\(limited to 20000 characters\)/)
  assert.match(formatted, /\.\.\. \(output truncated\) \.\.\./)
})

test("a command whose output went to a file reports the file instead", () => {
  const formatted = formatShellResult(shellResult({
    outputLocation: { filePath: "/t/1.txt", sizeBytes: 2_048, lineCount: 40 },
    executionTimeMs: 10,
  }))
  assert.match(formatted, /Saved command output: \/t\/1\.txt \(2\.0 KB, 40 lines\)/)
  assert.doesNotMatch(formatted, /```/)
})

test("a small file is reported in bytes", () => {
  const formatted = formatShellResult(shellResult({ outputLocation: { filePath: "/t/1.txt", sizeBytes: 512, lineCount: 3 } }))
  assert.match(formatted, /\(512 bytes, 3 lines\)/)
})

test("a minimal harness gets the short form", () => {
  const formatted = formatShellResult(shellResult({ useMinimalHarness: true, executionTimeMs: 5 }))
  assert.match(formatted, /^Exit code: 0\nRuntime: 5 ms\nOutput:\noutput$/)
})

// ---------------------------------------------------------------------------------------------
// what the sandbox allowed
// ---------------------------------------------------------------------------------------------

test("a sandboxed result says what the sandbox allowed", () => {
  const formatted = formatShellResult(shellResult({
    sandboxPolicy: { mode: "workspace-readwrite", networkAccess: true, networkPolicy: { allow: ["a.test"] } },
  }))
  assert.match(formatted, /Execution isolation applied these limits/)
  assert.match(formatted, /Filesystem writes stay within the workspace/)
  assert.match(formatted, /Network access is limited to the configured allowlist/)
  assert.match(formatted, /such as \["full_network"\]/)
})

test("an unsandboxed result explains the allowlist when that is why it ran free", () => {
  const escalated = formatShellResult(shellResult({
    sandboxPolicy: { mode: "unrestricted", allowlistEscalated: true },
  }))
  assert.match(escalated, /ran outside isolation because an approved command rule allowed it/)

  const plain = formatShellResult(shellResult({ sandboxPolicy: { mode: "unrestricted" } }))
  assert.doesNotMatch(plain, /Execution isolation/)
})

test("a failure the sandbox explains is answered with the permission that lifts it", () => {
  const sandboxFailure = formatShellResult(shellResult({
    exitCode: 1,
    combinedOutput: "operation not permitted",
    sandboxPolicy: { mode: "workspace-readwrite", networkAccess: false },
  }))
  assert.match(sandboxFailure, /looks like a filesystem denial/)
  assert.match(sandboxFailure, /required_permissions: \["all"\]/)

  const networkFailure = formatShellResult(shellResult({
    exitCode: 1,
    combinedOutput: "Could not resolve host",
    sandboxPolicy: { mode: "workspace-readwrite", networkAccess: false },
  }))
  assert.match(networkFailure, /looks like a network denial/)
  assert.match(networkFailure, /required_permissions: \["full_network"\]/)
})

test("a read-only sandbox is not told to lift a restriction it cannot lift", () => {
  const formatted = formatShellResult(shellResult({
    exitCode: 1,
    combinedOutput: "operation not permitted",
    sandboxPolicy: { mode: "workspace-readonly", networkAccess: false },
  }))
  assert.match(formatted, /Filesystem writes are blocked/)
  assert.doesNotMatch(formatted, /required_permissions: \["all"\]/)
})

// ---------------------------------------------------------------------------------------------
// a command still running
// ---------------------------------------------------------------------------------------------

test("a command that outlived its block-until duration says where its output goes", () => {
  const formatted = formatShellResult(shellResult({
    combinedOutput: "starting",
    outputLocation: { filePath: "/t/1.txt", sizeBytes: 10, lineCount: 1 },
  }))
  assert.match(formatted, /The command finished\./)
})

test("a backgrounded result names the shell, the pid and the output file", () => {
  const formatted = renderShellResultToString({
    result: { case: "success", value: { command: "sleep 100", shellId: 7, pid: 4242, msToWait: 30_000, interleavedOutput: "starting" } },
    terminalsFolder: "/t",
  })
  assert.match(formatted, /still running after 30000ms, so it continues in the background/)
  assert.match(formatted, /Internal shell handle: 7/)
  assert.match(formatted, /Process ID: 4242/)
  assert.match(formatted, /written to \/t\/7\.txt/)
  assert.match(formatted, /Do not show the internal shell handle to the user/)
  assert.match(formatted, /Output captured before backgrounding/)
})

test("a command the user backgrounded says so, and an interrupted one says why", () => {
  const byUser = renderShellResultToString({
    result: {
      case: "success",
      value: { command: "sleep", shellId: 1, msToWait: 5_000, backgroundReason: "user-request" },
    },
  })
  assert.match(byUser, /The user moved the command to the background after 5000ms\./)

  const byInterruption = renderShellResultToString({
    result: {
      case: "success",
      value: { command: "sleep", shellId: 1, msToWait: 5_000, backgroundReason: "user-request" },
    },
  }, { autoBackgroundedForInterruption: true })
  assert.match(byInterruption, /moved to the background after 5000ms when the user interrupted/)
  assert.match(byInterruption, /Stop the command if it should not keep running/)

  const discouraged = renderShellResultToString({
    result: {
      case: "success",
      value: { command: "sleep", shellId: 1, msToWait: 5_000, backgroundReason: "user-request" },
    },
  }, { discourageAwait: true })
  assert.match(discouraged, /Do NOT await it/)
})

test("a background command that was just started reports where its output will be", () => {
  const formatted = renderShellResultToString({
    result: { case: "success", value: { command: "npm run dev", shellId: 3, pid: 99 } },
    isBackground: true,
    terminalsFolder: "/t",
  })
  assert.match(formatted, /^A background command has started\./)
  assert.match(formatted, /Command: npm run dev/)
  assert.match(formatted, /Output goes to \/t\/3\.txt/)
})

test("with no terminals folder the path is shown as a placeholder", () => {
  const formatted = renderShellResultToString({
    result: { case: "success", value: { command: "x", shellId: 2 } },
    isBackground: true,
  })
  assert.match(formatted, /<terminals_folder>\/2\.txt/)
})

// ---------------------------------------------------------------------------------------------
// the ways a command can fail
// ---------------------------------------------------------------------------------------------

test("a timeout says the shell was terminated and that the next call starts a new one", () => {
  const formatted = renderShellResultToString({
    result: { case: "failure", value: { command: "sleep 1000", interleavedOutput: "waiting", abortReason: "timeout" } },
  })
  assert.match(formatted, /^The command reached its time limit\./)
  assert.match(formatted, /Output captured before the time limit/)
  assert.match(formatted, /its shell was stopped/)
})

test("a user abort is named before the result", () => {
  const formatted = renderShellResultToString({
    result: { case: "failure", value: { command: "ls", interleavedOutput: "a", abortReason: "user" } },
  })
  assert.match(formatted, /^The user stopped the command\.\nExit code:/)
})

test("an aborted flag without a reason counts as the user aborting", () => {
  const formatted = renderShellResultToString({
    result: { case: "failure", value: { command: "ls", aborted: true } },
  })
  assert.match(formatted, /^The user stopped the command\./)
})

test("a command that could not be spawned reports the command with the error", () => {
  const formatted = renderShellResultToString({
    result: { case: "spawnError", value: { command: "nope", error: "ENOENT" } },
  })
  assert.equal(formatted, "Could not start command: ENOENT\n\nCommand: nope")

  const withoutCommand = renderShellResultToString({ result: { case: "spawnError", value: { command: "", error: "ENOENT" } } })
  assert.equal(withoutCommand, "Could not start command: ENOENT")
})

test("a missing exit status is reported as unknown, with whatever output arrived", () => {
  const formatted = renderShellResultToString({
    result: { case: "spawnError", value: { command: "ls", error: formatShellMissingExitDisplay("partial") } },
  })
  assert.match(formatted, /outcome as unknown; do not assume it succeeded/)
  assert.match(formatted, /Output collected before the stream closed/)
})

test("a missing exit status with no output is just the message", () => {
  const message = formatShellMissingExitDisplay("")
  assert.equal(message.includes("```"), false)
  assert.match(message, /do not assume it succeeded/)
})

test("a permission denial says whether the session was read-only", () => {
  assert.equal(
    renderShellResultToString({ result: { case: "permissionDenied", value: { command: "x", isReadonly: true } } }),
    ASK_MODE_MODEL_ERROR,
  )
  assert.equal(
    renderShellResultToString({ result: { case: "permissionDenied", value: { command: "x", error: "blocked by policy" } } }),
    "Permission denied: blocked by policy",
  )
})

test("a rejection carries the reason the user gave", () => {
  assert.equal(
    renderShellResultToString({ result: { case: "rejected", value: { command: "rm -rf /", reason: "too dangerous" } } }),
    "Declined: too dangerous",
  )
})

test("a result with no case is reported as unknown, and an unhandled one is refused", () => {
  assert.equal(renderShellResultToString({ result: { value: { command: "x" } } as never }), "Unknown error")
  assert.throws(
    () => renderShellResultToString({ result: { case: "somethingNew", value: { command: "x" } } }),
    /Unsupported shell result: somethingNew/,
  )
})

test("a background command's failure reports what it said, and its rejection is named", () => {
  assert.equal(
    renderShellResultToString({ result: { case: "failure", value: { command: "x", stderr: "it broke" } }, isBackground: true }),
    "it broke",
  )
  assert.equal(
    renderShellResultToString({ result: { case: "failure", value: { command: "x", stdout: "out" } }, isBackground: true }),
    "out",
  )
  assert.equal(
    renderShellResultToString({ result: { case: "rejected", value: { command: "x" } }, isBackground: true }),
    "The user declined the background command",
  )
})

// ---------------------------------------------------------------------------------------------
// the version-specific result
// ---------------------------------------------------------------------------------------------

test("the version-specific result repeats the command and names the next shell's directory", () => {
  const formatted = formatShellResultForVersion(
    { combinedOutput: "out\n", exitCode: 0, command: "ls", workingDirectory: "/p" },
    "original",
  )
  assert.match(formatted, /^Exit code: 0\n\nCaptured output:\n\n```\nls\nout\n```/)
  assert.match(formatted, /The prior shell remains available for the next call/)
  assert.match(formatted, /current directory will still be \/p/)
})

test("the version-specific result uses the original command when the result does not carry one", () => {
  const formatted = formatShellResultForVersion({ combinedOutput: "out", exitCode: 0 }, "original")
  assert.match(formatted, /```\noriginal\nout\n```/)
})

test("the version-specific result names an aborted shell and can add the sandbox reminder", () => {
  const formatted = formatShellResultForVersion(
    {
      combinedOutput: "out",
      exitCode: 1,
      signal: "SIGTERM",
      sandboxPolicy: { mode: "workspace-readonly", networkAccess: false },
    },
    "ls",
    { includeSandboxReminder: true },
  )
  assert.match(formatted, /The command stopped\./)
  assert.match(formatted, /new shell at the project root/)
  assert.match(formatted, /Execution isolation applied these limits/)
})

test("a partial output section is only produced when there is output", () => {
  assert.equal(formatShellPartialOutputSection("", { heading: "Before", emptyMessage: "none" }), "none")
  assert.equal(formatShellPartialOutputSection("", { heading: "Before" }), "")
  assert.match(formatShellPartialOutputSection("text", { heading: "Before" }), /^Before:\n\n```\ntext\n```$/)
  assert.match(
    formatShellPartialOutputSection("x".repeat(30_000), { heading: "Before" }),
    /^Before \(truncated\):/,
  )
})

test("the result rendering chooses the version's formatter from the options", () => {
  const formatted = renderShellResultToString(
    { result: { case: "success", value: { command: "ls", interleavedOutput: "out", exitCode: 0 } } },
    { promptVersion: "dsv3-1018" },
  )
  assert.match(formatted, /The command finished\./)
  assert.match(formatted, /The prior shell remains available for the next call/)
})

test("a minimal harness is chosen by the options for the result rendering too", () => {
  const formatted = renderShellResultToString(
    { result: { case: "success", value: { command: "ls", interleavedOutput: "out", exitCode: 0 } } },
    { useMinimalHarness: true },
  )
  assert.match(formatted, /^Exit code: 0\nOutput:\nout$/)
})
