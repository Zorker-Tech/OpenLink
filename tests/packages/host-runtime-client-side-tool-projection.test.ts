/**
 * What a tool call looks like to the surface the user sees it in: the command it runs, the file it edits, the file it
 * reads, and what each of them says when it went wrong.
 */

import assert from "node:assert/strict";
import { describe, it } from "node:test";

import type { PartialMessage } from "@bufbuild/protobuf";

import { ToolCall } from "../../source/packages/proto/generated/agent/v1/agent_pb.ts";
import { EditToolCall } from "../../source/packages/proto/generated/agent/v1/edit_tool_pb.ts";
import { ClientSideToolV2, RunTerminalCommandEndedReason } from "../../source/packages/proto/generated/aiserver/v1/tools_pb.ts";
import { EditRejected, EditResult, EditSuccess, EditWritePermissionDenied } from "../../source/packages/proto/generated/agent/v1/edit_tool_pb.ts";
import { ReadToolError, ReadToolResult, ReadToolSuccess } from "../../source/packages/proto/generated/agent/v1/read_tool_pb.ts";
import { ReadToolCall } from "../../source/packages/proto/generated/agent/v1/read_tool_pb.ts";
import { ShellResult, ShellSuccess } from "../../source/packages/proto/generated/agent/v1/shell_exec_pb.ts";
import { ShellToolCall } from "../../source/packages/proto/generated/agent/v1/shell_tool_pb.ts";
import { projectAgentToolCallToClientSideToolV2 } from "../../source/host/transcript/client-side-tool-v2-projection.ts";

/** What a projected result says to the user, when it says anything. */
const deniedMessage = (projected: { kind: string; value: { error?: { clientVisibleErrorMessage: string } } }) => projected.value.error?.clientVisibleErrorMessage ?? "";

/** A tool call of the shape the agent makes, with whatever the test hands it. */
/** The tool a call carries, as the tests write it: the generated shapes are checked by the projection itself. */
const call = (tool: unknown) => new ToolCall({ tool } as never);
const json = (value: { toJson(): unknown }) => value.toJson() as Record<string, unknown>;

describe("projecting a tool call into the platform's own tool surface", () => {
  it("has nothing to show without a call, or for a tool this surface does not have", () => {
    const shell = call({ case: "shellToolCall", value: new ShellToolCall({ args: { command: "ls" } }) });
    assert.equal(projectAgentToolCallToClientSideToolV2("toolCallStarted", "", shell), null);
    // A tool the surface does not project is left alone rather than turned into something else.
    assert.equal(projectAgentToolCallToClientSideToolV2("toolCallStarted", "call-1", call(undefined)), null);
  });

  it("shows a command being run, with what it was given and whether the user is asked first", () => {
    const started = projectAgentToolCallToClientSideToolV2("toolCallStarted", "call-1", call({ case: "shellToolCall", value: new ShellToolCall({ args: { command: "ls -la", workingDirectory: "/workspace" } }) }), "model-call-1", "Terminal");
    assert.equal(started?.kind, "call");
    const shown = started?.kind === "call" ? started.value : undefined;
    assert.deepEqual({ tool: shown?.tool, name: shown?.name, modelCallId: shown?.modelCallId, isStreaming: shown?.isStreaming }, { tool: ClientSideToolV2.RUN_TERMINAL_COMMAND_V2, name: "Terminal", modelCallId: "model-call-1", isStreaming: false });
    assert.deepEqual(JSON.parse(String(shown?.rawArgs)), { command: "ls -la", cwd: "/workspace" });
    // What is at its own default is not carried in the generated JSON; what was asked for is carried.
    assert.deepEqual(json((shown?.params.value ?? {}) as never), { command: "ls -la", cwd: "/workspace", requireUserApproval: true });
    const background = projectAgentToolCallToClientSideToolV2("toolCallStarted", "call-1", call({ case: "shellToolCall", value: new ShellToolCall({ args: { command: "watch", isBackground: true } }) }));
    assert.equal(background?.kind === "call" ? json((background.value.params.value ?? {}) as never).isBackground : null, true);
    // A command that is still being written is shown as streaming, and one with nothing to run is not shown at all.
    const partial = projectAgentToolCallToClientSideToolV2("partialToolCall", "call-1", call({ case: "shellToolCall", value: new ShellToolCall({ args: { command: "ls" } }) }));
    assert.equal(partial?.kind === "call" ? partial.value.isStreaming : null, true);
    assert.equal(projectAgentToolCallToClientSideToolV2("toolCallStarted", "call-1", call({ case: "shellToolCall", value: new ShellToolCall({ args: { command: "" } }) })), null);
    assert.equal(projectAgentToolCallToClientSideToolV2("toolCallStarted", "call-1", call({ case: "shellToolCall", value: new ShellToolCall({}) })), null);
    // A command the user approved beforehand is not asked about again.
    const approved = projectAgentToolCallToClientSideToolV2("toolCallStarted", "call-1", call({ case: "shellToolCall", value: new ShellToolCall({ args: { command: "ls", skipApproval: true } }) }));
    assert.equal(approved?.kind === "call" ? (approved.value.params.value as { requireUserApproval: boolean }).requireUserApproval : null, false);
    // With no name of its own, the surface's own name stands in, and an absent model call id is not carried.
    const bare = projectAgentToolCallToClientSideToolV2("toolCallStarted", "call-1", call({ case: "shellToolCall", value: new ShellToolCall({ args: { command: "ls" } }) }));
    assert.deepEqual(bare?.kind === "call" ? { name: bare.value.name, modelCallId: bare.value.modelCallId } : null, { name: "Shell", modelCallId: undefined });
  });

  it("shows what a command answered, and what it refused with", () => {
    const completed = (result: unknown) => projectAgentToolCallToClientSideToolV2("toolCallCompleted", "call-1", call({ case: "shellToolCall", value: new ShellToolCall({ result: result as never }) }));
    // A command that ran is shown with how it ended and what it printed.
    const shellCall = call({
      case: "shellToolCall",
      value: new ShellToolCall({
        args: { command: "ls", isBackground: true },
        result: new ShellResult({
          result: { case: "success", value: new ShellSuccess({ exitCode: 3, stdout: "one", stderr: "", interleavedOutput: "one", workingDirectory: "/workspace" }) },
        }),
      }),
    });
    const success = projectAgentToolCallToClientSideToolV2("toolCallCompleted", "call-1", shellCall);
    const shown = success?.kind === "result" ? success.value : undefined;
    assert.equal(shown?.tool, ClientSideToolV2.RUN_TERMINAL_COMMAND_V2);
    const result = json((shown?.result.value ?? {}) as never);
    // A command that ran to the end is shown with everything it printed and where it left the shell; this platform's
    // own shell result carries no background flag, so nothing is projected as running in the background either.
    assert.deepEqual({ output: result.output, raw: result.outputRaw, exitCode: result.exitCode, exitCodeV2: result.exitCodeV2, cwd: result.resultingWorkingDirectory, endedReason: (shown?.result.value as unknown as { endedReason: number }).endedReason, background: result.isRunningInBackground }, { output: "one", raw: "one", exitCode: 3, exitCodeV2: 3, cwd: "/workspace", endedReason: RunTerminalCommandEndedReason.EXECUTION_COMPLETED, background: undefined });
    // Without what it printed, the two streams are what it said, in order, with nothing left over for an empty one.
    const split = completed(new ShellResult({ result: { case: "success", value: new ShellSuccess({ exitCode: 0, stdout: "out", stderr: "err" }) } }));
    // A command that printed on both streams and said nothing together is shown as both of them.

    const splitResult = split?.kind === "result" ? json((split.value.result.value ?? {}) as never) : {};
    assert.equal(String(splitResult.output).includes("out"), true);
    assert.equal(String(splitResult.output).includes("err"), true);
    // A refused command, one that could not start, and one that timed out each say what happened.
    const denied = completed(new ShellResult({ result: { case: "permissionDenied", value: { error: "not allowed" } } }));
    assert.equal(denied?.kind === "result" ? denied.value.error?.clientVisibleErrorMessage : "", "Permission denied: not allowed");
    const spawn = completed(new ShellResult({ result: { case: "spawnError", value: { error: "no shell" } } }));
    assert.equal(spawn?.kind === "result" ? spawn.value.error?.clientVisibleErrorMessage : "", "no shell");
    // A command that timed out is shown as having answered, not as having failed to start.
    const timedOut = completed(new ShellResult({ result: { case: "timeout", value: {} } }));
    const endedReasonOf = (projected: typeof timedOut) => (projected?.kind === "result" ? (projected.value.result.value as unknown as { endedReason: number }).endedReason : null);
    assert.equal(endedReasonOf(timedOut), RunTerminalCommandEndedReason.IDLE_TIMEOUT);
    // A command the user stopped is shown as stopped, and one that just failed as failed.
    const aborted = completed(new ShellResult({ result: { case: "failure", value: { exitCode: 2, stdout: "no", aborted: true } } }));
    assert.equal(endedReasonOf(aborted), RunTerminalCommandEndedReason.EXECUTION_ABORTED);
    const failed = completed(new ShellResult({ result: { case: "failure", value: { exitCode: 2, stdout: "no" } } }));
    assert.equal(endedReasonOf(failed), RunTerminalCommandEndedReason.EXECUTION_FAILED);
    // Nothing to answer with is nothing to show.
    assert.equal(completed(undefined), null);
    assert.equal(completed(new ShellResult({})), null);
  });

  it("shows a file being edited, and what the edit did to it", () => {
    const started = projectAgentToolCallToClientSideToolV2("toolCallStarted", "call-1", call({ case: "editToolCall", value: new EditToolCall({ args: { path: "src/a.ts", streamContent: "const a = 1" } }) }), "model-call-1");
    const shown = started?.kind === "call" ? started.value : undefined;
    assert.deepEqual({ tool: shown?.tool, name: shown?.name }, { tool: ClientSideToolV2.EDIT_FILE_V2, name: "Edit" });
    assert.deepEqual(JSON.parse(String(shown?.rawArgs)), { path: "src/a.ts" });
    assert.deepEqual(json((shown?.params.value ?? {}) as never), { relativeWorkspacePath: "src/a.ts", streamingContent: "const a = 1" });
    // An edit with no file to edit is not shown.
    assert.equal(projectAgentToolCallToClientSideToolV2("toolCallStarted", "call-1", call({ case: "editToolCall", value: new EditToolCall({ args: {} }) })), null);

    const editDone = (result: unknown) => projectAgentToolCallToClientSideToolV2("toolCallCompleted", "call-1", call({ case: "editToolCall", value: new EditToolCall({ result: result as never }) }));
    // What the edit produced is shown as the difference it made, and what it says for the model.
    const applied = editDone(new EditResult({ result: { case: "success", value: new EditSuccess({ diffString: "@@ -1 +1 @@", beforeFullFileContent: "old", afterFullFileContent: "new", message: "done" }) } }));
    const appliedResult = applied?.kind === "result" ? json((applied.value.result.value ?? {}) as never) : {};
    assert.deepEqual({ before: appliedResult.contentsBeforeEdit, after: appliedResult.contentsAfterEdit, model: appliedResult.resultForModel }, { before: "old", after: "new", model: "done" });
    assert.equal(JSON.stringify(appliedResult.diff).includes("@@ -1 +1 @@"), true);
    // An edit that made the file says so, and one that was refused is shown as refused.
    const created = editDone(new EditResult({ result: { case: "success", value: new EditSuccess({ diffString: "@@ -0 +1 @@" }) } }));
    assert.equal(created?.kind === "result" ? json((created.value.result.value ?? {}) as never).fileWasCreated : null, true);
    const rejected = editDone(new EditResult({ result: { case: "rejected", value: new EditRejected({ reason: "nope" }) } }));
    assert.deepEqual(rejected?.kind === "result" ? { rejected: json((rejected.value.result.value ?? {}) as never).rejected, model: json((rejected.value.result.value ?? {}) as never).resultForModel } : null, { rejected: true, model: "nope" });
    // An edit the platform would not allow says why, and one that failed is reported as failed.
    const denied = editDone(new EditResult({ result: { case: "writePermissionDenied", value: new EditWritePermissionDenied({ error: "not yours" }) } }));
    assert.equal(denied?.kind === "result" ? denied.value.error?.clientVisibleErrorMessage : "", "Permission denied: not yours");
    const failed = editDone(new EditResult({ result: { case: "error", value: { error: "the file moved" } } }));
    assert.equal(failed?.kind === "result" ? failed.value.error?.clientVisibleErrorMessage : "", "the file moved");
    // Nothing to answer with is nothing to show.
    assert.equal(editDone(undefined), null);
  });

  it("shows a file being read, and says when it could not be shown as text", () => {
    const started = projectAgentToolCallToClientSideToolV2("toolCallStarted", "call-1", call({ case: "readToolCall", value: new ReadToolCall({ args: { path: "src/a.ts" } }) }));
    assert.equal(started?.kind === "call" ? started.value.tool : null, ClientSideToolV2.READ_FILE_V2);
    assert.equal(projectAgentToolCallToClientSideToolV2("toolCallStarted", "call-1", call({ case: "readToolCall", value: new ReadToolCall({ args: {} }) })), null);
    const completed = (result: unknown) => projectAgentToolCallToClientSideToolV2("toolCallCompleted", "call-1", call({ case: "readToolCall", value: new ReadToolCall({ result: result as never }) }));
    const read = completed(new ReadToolResult({ result: { case: "success", value: new ReadToolSuccess({ path: "src/a.ts", output: { case: "content", value: "one\ntwo" }, totalLines: 2, fileSize: 7 }) } }));
    const shown = read?.kind === "result" ? json((read.value.result.value ?? {}) as never) : {};
    assert.deepEqual({ contents: shown.contents, characters: shown.numCharactersInRequestedRange, lines: shown.totalLinesInFile }, { contents: "one\ntwo", characters: 7, lines: 2 });
    // What could not be read as text is said rather than shown as bytes.
    const bytes = completed(new ReadToolResult({ result: { case: "error", value: new ReadToolError({ errorMessage: "could not be read as text" }) } }));
    assert.equal(bytes?.kind === "result" ? bytes.value.error?.clientVisibleErrorMessage : "", "could not be read as text");
    // A read that failed says what it failed with.
    // A read that came back as bytes rather than text says so rather than showing them as if they were words.
    const asBytes = completed(new ReadToolResult({ result: { case: "success", value: new ReadToolSuccess({ path: "a.png", output: { case: "data", value: new Uint8Array([1, 2, 3]) }, totalLines: 0, fileSize: 3 }) } }));
    assert.equal(asBytes?.kind === "result" ? asBytes.value.error?.clientVisibleErrorMessage : "", "Read completed with non-text content; bytes remain available in ordinary transcript transport");
    // A read that failed with nothing said about why still says that it failed.
    const failed = completed(new ReadToolResult({ result: { case: "error", value: new ReadToolError({}) } }));
    assert.equal(failed?.kind === "result" ? failed.value.error?.clientVisibleErrorMessage : "", "Tool failed: error");
    assert.equal(completed(undefined), null);
  });
});
