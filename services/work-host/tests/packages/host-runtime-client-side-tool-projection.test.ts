/**
 * What a tool call looks like to the surface the user sees it in: the command it runs, the file it edits, the file it
 * reads, and what each of them says when it went wrong.
 */

import assert from "node:assert/strict";
import { describe, it } from "node:test";

import type { PartialMessage } from "@bufbuild/protobuf";

import { ToolCall } from "../../source/adapters/interop/proto/generated/agent/v1/agent_pb.ts";
import { EditToolCall } from "../../source/adapters/interop/proto/generated/agent/v1/edit_tool_pb.ts";
import { ClientSideToolV2, RunTerminalCommandEndedReason } from "../../source/adapters/interop/proto/generated/aiserver/v1/tools_pb.ts";
import { EditRejected, EditResult, EditSuccess, EditWritePermissionDenied } from "../../source/adapters/interop/proto/generated/agent/v1/edit_tool_pb.ts";
import { ReadToolError, ReadToolResult, ReadToolSuccess } from "../../source/adapters/interop/proto/generated/agent/v1/read_tool_pb.ts";
import { ReadToolCall } from "../../source/adapters/interop/proto/generated/agent/v1/read_tool_pb.ts";
import { ShellRejected, ShellResult, ShellSuccess } from "../../source/adapters/interop/proto/generated/agent/v1/shell_exec_pb.ts";
import { ShellToolCall } from "../../source/adapters/interop/proto/generated/agent/v1/shell_tool_pb.ts";
import { Struct } from "@bufbuild/protobuf";

import { TaskResult, TaskSuccess, TaskToolCall } from "../../source/adapters/interop/proto/generated/agent/v1/agent_pb.ts";
import { AskQuestionResult, AskQuestionSuccess, AskQuestionToolCall } from "../../source/adapters/interop/proto/generated/agent/v1/ask_question_tool_pb.ts";
import { ComputerUseResult, ComputerUseToolCall } from "../../source/adapters/interop/proto/generated/agent/v1/computer_use_tool_pb.ts";
import { GenerateImageResult, GenerateImageSuccess, GenerateImageToolCall } from "../../source/adapters/interop/proto/generated/agent/v1/generate_image_tool_pb.ts";
import { GetMcpToolsAgentResult, GetMcpToolsSuccess, GetMcpToolsToolCall } from "../../source/adapters/interop/proto/generated/agent/v1/get_mcp_tools_tool_pb.ts";
import { McpAuthResult, McpAuthSuccess, McpAuthToolCall } from "../../source/adapters/interop/proto/generated/agent/v1/mcp_auth_tool_pb.ts";
import { ListMcpResourcesSuccess, McpSuccess, ReadMcpResourceSuccess } from "../../source/adapters/interop/proto/generated/agent/v1/mcp_exec_pb.ts";
import { ListMcpResourcesToolCall, ReadMcpResourceToolCall } from "../../source/adapters/interop/proto/generated/agent/v1/mcp_resource_tool_pb.ts";
import { McpToolCall, McpToolResult } from "../../source/adapters/interop/proto/generated/agent/v1/mcp_tool_pb.ts";
import { RecordScreenResult, RecordScreenStartSuccess } from "../../source/adapters/interop/proto/generated/agent/v1/record_screen_exec_pb.ts";
import { RecordScreenToolCall } from "../../source/adapters/interop/proto/generated/agent/v1/record_screen_tool_pb.ts";
import { WebFetchResult, WebFetchSuccess, WebFetchToolCall } from "../../source/adapters/interop/proto/generated/agent/v1/web_fetch_tool_pb.ts";
import { WebSearchResult, WebSearchSuccess, WebSearchToolCall } from "../../source/adapters/interop/proto/generated/agent/v1/web_search_tool_pb.ts";
import { projectAgentToolCallToClientSideToolV2 } from "../../source/adapters/interop/agent/client-side-tool-v2-projection-adapter.ts";

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
    // Whether a command runs in the background is what its result says, not what the call asked for.
    const background = completed(new ShellResult({ isBackground: true, result: { case: "success", value: new ShellSuccess({ exitCode: 0, stdout: "bg" }) } }));
    assert.equal(background?.kind === "result" ? json((background.value.result.value ?? {}) as never).isRunningInBackground : null, true);
    // A run the user refused is shown as not carried out, with why.
    const refused = completed(new ShellResult({ result: { case: "rejected", value: new ShellRejected({ reason: "not now" }) } }));
    assert.equal(endedReasonOf(refused), RunTerminalCommandEndedReason.UNSPECIFIED);
    assert.equal(refused?.kind === "result" ? json((refused.value.result.value ?? {}) as never).rejected : null, true);
    // A command that could not start with nothing said about why still says it could not start.
    const quietSpawn = completed(new ShellResult({ result: { case: "spawnError", value: {} } }));
    assert.equal(quietSpawn?.kind === "result" ? quietSpawn.value.error?.clientVisibleErrorMessage : "", "Command could not be started");
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

  it("shows an MCP tool call and what the server answered", () => {
    const started = projectAgentToolCallToClientSideToolV2("toolCallStarted", "call-1", call({ case: "mcpToolCall", value: new McpToolCall({ args: { name: "MCP tool", toolName: "run", serverIdentifier: "srv" } }) }));
    const shown = started?.kind === "call" ? started.value : undefined;
    assert.equal(shown?.tool, ClientSideToolV2.CALL_MCP_TOOL);
    assert.equal(shown?.name, "MCP tool");
    // The raw arguments are the whole call's arguments; the typed ones are the server, tool and argument object.
    const raw = JSON.parse(String(shown?.rawArgs)) as Record<string, unknown>;
    assert.deepEqual({ name: raw.name, toolName: raw.toolName, serverIdentifier: raw.serverIdentifier }, { name: "MCP tool", toolName: "run", serverIdentifier: "srv" });
    assert.deepEqual(json((shown?.params.value ?? {}) as never), { server: "srv", toolName: "run", toolArgs: {} });
    // With no name of its own the surface calls it MCP, and a server the args do not name stays unnamed.
    const bare = projectAgentToolCallToClientSideToolV2("toolCallStarted", "call-1", call({ case: "mcpToolCall", value: new McpToolCall({ args: { toolName: "run", providerIdentifier: "prov" } }) }));
    const bareShown = bare?.kind === "call" ? bare.value : undefined;
    assert.deepEqual(bareShown ? { name: bareShown.name, params: json((bareShown.params.value ?? {}) as never) } : null, { name: "MCP", params: { toolName: "run", toolArgs: {} } });
    // A server call with no tool name to make is not shown.
    assert.equal(projectAgentToolCallToClientSideToolV2("toolCallStarted", "call-1", call({ case: "mcpToolCall", value: new McpToolCall({ args: { name: "MCP tool" } }) })), null);

    const completed = (result: unknown) => projectAgentToolCallToClientSideToolV2("toolCallCompleted", "call-1", call({ case: "mcpToolCall", value: new McpToolCall({ args: { name: "MCP tool", serverIdentifier: "srv", toolName: "run" }, result: result as never }) }));
    const answerOf = (projected: ReturnType<typeof completed>) => projected?.kind === "result" ? json((projected.value.result.value ?? {}) as never) : {};
    // What the server said is shown with the server and tool it came from, and a structured answer is shown as itself.
    assert.deepEqual(answerOf(completed(new McpToolResult({ result: { case: "success", value: new McpSuccess({ content: [{ content: { case: "text", value: { text: "hi" } } }], isError: true }) } }))), { server: "srv", toolName: "run", result: { content: [{ text: { text: "hi" } }], isError: true } });
    assert.deepEqual(answerOf(completed(new McpToolResult({ result: { case: "success", value: new McpSuccess({ structuredContent: new Struct({ fields: { answer: { kind: { case: "stringValue", value: "42" } } } }) }) } }))), { server: "srv", toolName: "run", result: { answer: "42" } });
    const saidBy = (projected: ReturnType<typeof completed>) => projected?.kind === "result" ? projected.value.error?.clientVisibleErrorMessage : null;
    assert.equal(saidBy(completed(new McpToolResult({ result: { case: "error", value: { error: "server died" } } }))), "server died");
    assert.equal(saidBy(completed(new McpToolResult({ result: { case: "error", value: {} } }))), "Tool failed: error");
    assert.equal(completed(undefined), null);
  });

  it("shows a subagent task being started and what it came back with", () => {
    const started = projectAgentToolCallToClientSideToolV2("toolCallStarted", "call-1", call({ case: "taskToolCall", value: new TaskToolCall({ args: { prompt: "do it", description: "Job", model: "model-1", mode: 2 } }) }));
    const shown = started?.kind === "call" ? started.value : undefined;
    assert.equal(shown?.tool, ClientSideToolV2.TASK_V2);
    assert.equal(shown?.name, "Task");
    assert.deepEqual(json((shown?.params.value ?? {}) as never), { description: "Job", prompt: "do it", model: "model-1", name: "Job", mode: "TASK_MODE_PLAN" });
    // A task with nothing to do is not shown.
    assert.equal(projectAgentToolCallToClientSideToolV2("toolCallStarted", "call-1", call({ case: "taskToolCall", value: new TaskToolCall({ args: { prompt: "" } }) })), null);
    assert.equal(projectAgentToolCallToClientSideToolV2("toolCallStarted", "call-1", call({ case: "taskToolCall", value: new TaskToolCall({}) })), null);
    // The subagent it started, whether it runs in the background, and the cloud agent it belongs to.
    const completed = projectAgentToolCallToClientSideToolV2("toolCallCompleted", "call-1", call({ case: "taskToolCall", value: new TaskToolCall({ cloudAgentBcId: "bc-1", result: new TaskResult({ result: { case: "success", value: new TaskSuccess({ agentId: "agent-1", isBackground: true }) } }) }) }));
    assert.deepEqual(completed?.kind === "result" ? json((completed.value.result.value ?? {}) as never) : null, { agentId: "agent-1", isBackground: true, cloudAgentBcId: "bc-1" });
    const failedTask = projectAgentToolCallToClientSideToolV2("toolCallCompleted", "call-1", call({ case: "taskToolCall", value: new TaskToolCall({ result: new TaskResult({ result: { case: "error", value: { error: "no agents" } } }) }) }));
    assert.equal(failedTask?.kind === "result" ? failedTask.value.error?.clientVisibleErrorMessage : null, "no agents");
    assert.equal(projectAgentToolCallToClientSideToolV2("toolCallCompleted", "call-1", call({ case: "taskToolCall", value: new TaskToolCall({}) })), null);
  });

  it("shows the MCP resources a server has, and the one that was read", () => {
    // Listing needs no arguments, and shows the server as it was asked for, empty or not.
    const listed = projectAgentToolCallToClientSideToolV2("toolCallStarted", "call-1", call({ case: "listMcpResourcesToolCall", value: new ListMcpResourcesToolCall({ args: { server: "srv" } }) }));
    const listedShown = listed?.kind === "call" ? listed.value : undefined;
    assert.deepEqual(listedShown ? { tool: listedShown.tool, name: listedShown.name, params: json((listedShown.params.value ?? {}) as never) } : null, { tool: ClientSideToolV2.LIST_MCP_RESOURCES, name: "ListMcpResources", params: { server: "srv" } });
    assert.equal(projectAgentToolCallToClientSideToolV2("toolCallStarted", "call-1", call({ case: "listMcpResourcesToolCall", value: new ListMcpResourcesToolCall({ args: {} }) }))?.kind, "call");
    assert.equal(projectAgentToolCallToClientSideToolV2("toolCallStarted", "call-1", call({ case: "listMcpResourcesToolCall", value: new ListMcpResourcesToolCall({}) })), null);
    const listedAnswer = projectAgentToolCallToClientSideToolV2("toolCallCompleted", "call-1", call({ case: "listMcpResourcesToolCall", value: new ListMcpResourcesToolCall({ result: { result: { case: "success", value: new ListMcpResourcesSuccess({ resources: [{ uri: "file://a", name: "a" }] }) } } }) }));
    assert.deepEqual(listedAnswer?.kind === "result" ? json((listedAnswer.value.result.value ?? {}) as never) : null, { resources: [{ uri: "file://a", name: "a" }] });

    // Reading one needs both the server and the resource, and carries where it is downloaded to.
    assert.equal(projectAgentToolCallToClientSideToolV2("toolCallStarted", "call-1", call({ case: "readMcpResourceToolCall", value: new ReadMcpResourceToolCall({ args: { server: "srv" } }) })), null);
    assert.equal(projectAgentToolCallToClientSideToolV2("toolCallStarted", "call-1", call({ case: "readMcpResourceToolCall", value: new ReadMcpResourceToolCall({ args: { uri: "file://a" } }) })), null);
    const read = projectAgentToolCallToClientSideToolV2("toolCallStarted", "call-1", call({ case: "readMcpResourceToolCall", value: new ReadMcpResourceToolCall({ args: { server: "srv", uri: "file://a", downloadPath: "/tmp/a" } }) }));
    const readShown = read?.kind === "call" ? read.value : undefined;
    assert.deepEqual(readShown ? { tool: readShown.tool, name: readShown.name, params: json((readShown.params.value ?? {}) as never) } : null, { tool: ClientSideToolV2.READ_MCP_RESOURCE, name: "ReadMcpResource", params: { server: "srv", uri: "file://a", downloadPath: "/tmp/a" } });
    const readAnswer = projectAgentToolCallToClientSideToolV2("toolCallCompleted", "call-1", call({ case: "readMcpResourceToolCall", value: new ReadMcpResourceToolCall({ result: { result: { case: "success", value: new ReadMcpResourceSuccess({ uri: "file://a", name: "a", content: { case: "text", value: "hi" } }) } } }) }));
    assert.deepEqual(readAnswer?.kind === "result" ? json((readAnswer.value.result.value ?? {}) as never) : null, { uri: "file://a", name: "a", text: "hi" });
    assert.equal(readAnswer?.kind === "result" ? readAnswer.value.result.case : null, "readMcpResourceResult");
  });

  it("asks the user a question and carries the answer, or the asynchronous start of one", () => {
    const started = projectAgentToolCallToClientSideToolV2("toolCallStarted", "call-1", call({ case: "askQuestionToolCall", value: new AskQuestionToolCall({ args: { title: "Pick one", runAsync: true, questions: [{ id: "q1", prompt: "Which?", allowMultiple: true, options: [{ id: "a", label: "A" }, { id: "b", label: "B" }] }] } }) }));
    const shown = started?.kind === "call" ? started.value : undefined;
    assert.equal(shown?.tool, ClientSideToolV2.ASK_QUESTION);
    assert.equal(shown?.name, "AskQuestion");
    assert.deepEqual(json((shown?.params.value ?? {}) as never), { title: "Pick one", runAsync: true, questions: [{ id: "q1", prompt: "Which?", allowMultiple: true, options: [{ id: "a", label: "A" }, { id: "b", label: "B" }] }] });
    assert.equal(projectAgentToolCallToClientSideToolV2("toolCallStarted", "call-1", call({ case: "askQuestionToolCall", value: new AskQuestionToolCall({}) })), null);

    const completed = (result: unknown) => projectAgentToolCallToClientSideToolV2("toolCallCompleted", "call-1", call({ case: "askQuestionToolCall", value: new AskQuestionToolCall({ result: result as never }) }));
    // A question answered at once says it was not asynchronous, and an asynchronous one says it was.
    const answered = completed(new AskQuestionResult({ result: { case: "success", value: new AskQuestionSuccess({ answers: [{ questionId: "q1", selectedOptionIds: ["a"], freeformText: "free" }] }) } }));
    assert.deepEqual(answered?.kind === "result" ? json((answered.value.result.value ?? {}) as never) : null, { answers: [{ questionId: "q1", selectedOptionIds: ["a"], freeformText: "free" }] });
    const asynchronous = completed(new AskQuestionResult({ result: { case: "async", value: {} } }));
    assert.equal(asynchronous?.kind === "result" ? json((asynchronous.value.result.value ?? {}) as never).isAsync : null, true);
    const saidBy = (projected: ReturnType<typeof completed>) => projected?.kind === "result" ? projected.value.error?.clientVisibleErrorMessage : null;
    assert.equal(saidBy(completed(new AskQuestionResult({ result: { case: "error", value: { errorMessage: "no user" } } }))), "no user");
    assert.equal(saidBy(completed(new AskQuestionResult({ result: { case: "rejected", value: { reason: "not now" } } }))), "not now");
    assert.equal(completed(undefined), null);
  });

  it("authorises an MCP server, searches the web and fetches a page", () => {
    const auth = projectAgentToolCallToClientSideToolV2("toolCallStarted", "call-1", call({ case: "mcpAuthToolCall", value: new McpAuthToolCall({ args: { serverIdentifier: "srv" } }) }));
    const authShown = auth?.kind === "call" ? auth.value : undefined;
    assert.deepEqual(authShown ? { tool: authShown.tool, name: authShown.name, params: json((authShown.params.value ?? {}) as never) } : null, { tool: ClientSideToolV2.MCP_AUTH, name: "McpAuth", params: { serverIdentifier: "srv" } });
    assert.equal(projectAgentToolCallToClientSideToolV2("toolCallStarted", "call-1", call({ case: "mcpAuthToolCall", value: new McpAuthToolCall({ args: {} }) })), null);
    const authAnswer = projectAgentToolCallToClientSideToolV2("toolCallCompleted", "call-1", call({ case: "mcpAuthToolCall", value: new McpAuthToolCall({ result: new McpAuthResult({ result: { case: "success", value: new McpAuthSuccess({ serverIdentifier: "srv" }) } }) }) }));
    assert.deepEqual(authAnswer?.kind === "result" ? json((authAnswer.value.result.value ?? {}) as never) : null, { success: true, message: "srv" });

    // Search needs a term and shows what it found, or that it was rejected rather than failed.
    assert.equal(projectAgentToolCallToClientSideToolV2("toolCallStarted", "call-1", call({ case: "webSearchToolCall", value: new WebSearchToolCall({ args: { searchTerm: "" } }) })), null);
    const search = projectAgentToolCallToClientSideToolV2("toolCallStarted", "call-1", call({ case: "webSearchToolCall", value: new WebSearchToolCall({ args: { searchTerm: "slate" } }) }));
    assert.deepEqual(json(((search?.kind === "call" ? search.value.params.value : {}) as never)), { searchTerm: "slate" });
    const searchResult = (result: unknown) => projectAgentToolCallToClientSideToolV2("toolCallCompleted", "call-1", call({ case: "webSearchToolCall", value: new WebSearchToolCall({ result: result as never }) }));
    const found = searchResult(new WebSearchResult({ result: { case: "success", value: new WebSearchSuccess({ references: [{ title: "T", url: "https://x" }] }) } }));
    assert.deepEqual(found?.kind === "result" ? json((found.value.result.value ?? {}) as never) : null, { references: [{ title: "T", url: "https://x" }], isFinal: true, rejected: false });
    const rejectedSearch = searchResult(new WebSearchResult({ result: { case: "rejected", value: { reason: "no" } } }));
    assert.equal(rejectedSearch?.kind === "result" ? json((rejectedSearch.value.result.value ?? {}) as never).rejected : null, true);
    const quietSearch = searchResult(new WebSearchResult({ result: { case: "error", value: {} } }));
    assert.equal(quietSearch?.kind === "result" ? quietSearch.value.error?.clientVisibleErrorMessage : null, "Tool failed: error");
    assert.equal(searchResult(undefined), null);

    // A fetch needs a url; what it says is the page, and the url the answer left empty is not filled in from the call.
    assert.equal(projectAgentToolCallToClientSideToolV2("toolCallStarted", "call-1", call({ case: "webFetchToolCall", value: new WebFetchToolCall({ args: { url: "" } }) })), null);
    const fetchResult = (args: unknown, result: unknown) => projectAgentToolCallToClientSideToolV2("toolCallCompleted", "call-1", call({ case: "webFetchToolCall", value: new WebFetchToolCall({ args: args as never, result: result as never }) }));
    const fetched = fetchResult({ url: "https://asked" }, new WebFetchResult({ result: { case: "success", value: new WebFetchSuccess({ url: "https://got", markdown: "# hi" }) } }));
    assert.deepEqual(fetched?.kind === "result" ? json((fetched.value.result.value ?? {}) as never) : null, { url: "https://got", markdown: "# hi" });
    const failedFetch = fetchResult({ url: "https://asked" }, new WebFetchResult({ result: { case: "error", value: { error: "blocked" } } }));
    assert.deepEqual(failedFetch?.kind === "result" ? json((failedFetch.value.result.value ?? {}) as never) : null, { error: "blocked" });
  });

  it("shows computer use, generated images and screen recordings the generated shapes carry", () => {
    const computer = projectAgentToolCallToClientSideToolV2("toolCallStarted", "call-1", call({ case: "computerUseToolCall", value: new ComputerUseToolCall({ args: { actions: [] } }) }));
    const computerShown = computer?.kind === "call" ? computer.value : undefined;
    assert.deepEqual(computerShown ? { tool: computerShown.tool, name: computerShown.name, params: json((computerShown.params.value ?? {}) as never) } : null, { tool: ClientSideToolV2.COMPUTER_USE, name: "Computer", params: {} });
    const computerAnswer = projectAgentToolCallToClientSideToolV2("toolCallCompleted", "call-1", call({ case: "computerUseToolCall", value: new ComputerUseToolCall({ result: new ComputerUseResult({ result: { case: "success", value: { screenshot: "png" } } }) }) }));
    assert.equal(computerAnswer?.kind === "result" ? computerAnswer.value.result.case : null, "computerUseResult");
    assert.equal(projectAgentToolCallToClientSideToolV2("toolCallCompleted", "call-1", call({ case: "computerUseToolCall", value: new ComputerUseToolCall({}) })), null);

    // The generated call union has no parameters arm for a generated image, so the call carries only its arguments.
    const image = projectAgentToolCallToClientSideToolV2("toolCallStarted", "call-1", call({ case: "generateImageToolCall", value: new GenerateImageToolCall({ args: { description: "a cat" } }) }));
    const imageShown = image?.kind === "call" ? image.value : undefined;
    assert.equal(imageShown?.tool, ClientSideToolV2.GENERATE_IMAGE);
    assert.equal(imageShown?.name, "GenerateImage");
    assert.deepEqual(JSON.parse(String(imageShown?.rawArgs)), { description: "a cat", referenceImagePaths: [] });
    assert.equal(projectAgentToolCallToClientSideToolV2("toolCallStarted", "call-1", call({ case: "generateImageToolCall", value: new GenerateImageToolCall({ args: {} }) })), null);
    const imageAnswer = projectAgentToolCallToClientSideToolV2("toolCallCompleted", "call-1", call({ case: "generateImageToolCall", value: new GenerateImageToolCall({ result: new GenerateImageResult({ result: { case: "success", value: new GenerateImageSuccess({ filePath: "/tmp/cat.png" }) } }) }) }));
    assert.equal(imageAnswer?.kind === "result" ? imageAnswer.value.result.case : null, "generateImageResult");

    const screen = projectAgentToolCallToClientSideToolV2("toolCallStarted", "call-1", call({ case: "recordScreenToolCall", value: new RecordScreenToolCall({ args: {} }) }));
    const screenShown = screen?.kind === "call" ? screen.value : undefined;
    assert.deepEqual(screenShown ? { tool: screenShown.tool, name: screenShown.name, params: json((screenShown.params.value ?? {}) as never) } : null, { tool: ClientSideToolV2.RECORD_SCREEN, name: "RecordScreen", params: {} });
    assert.equal(projectAgentToolCallToClientSideToolV2("toolCallStarted", "call-1", call({ case: "recordScreenToolCall", value: new RecordScreenToolCall({}) })), null);
    const screenAnswer = projectAgentToolCallToClientSideToolV2("toolCallCompleted", "call-1", call({ case: "recordScreenToolCall", value: new RecordScreenToolCall({ result: new RecordScreenResult({ result: { case: "startSuccess", value: new RecordScreenStartSuccess({ wasPriorRecordingCancelled: true }) } }) }) }));
    assert.equal(screenAnswer?.kind === "result" ? screenAnswer.value.result.case : null, "recordScreenResult");
    assert.equal(projectAgentToolCallToClientSideToolV2("toolCallCompleted", "call-1", call({ case: "recordScreenToolCall", value: new RecordScreenToolCall({}) })), null);
  });

  it("shows the MCP tools a server has, and keeps the caller's name for what it reads", () => {
    const started = projectAgentToolCallToClientSideToolV2("toolCallStarted", "call-1", call({ case: "getMcpToolsToolCall", value: new GetMcpToolsToolCall({ args: { server: "srv", toolName: "run", pattern: "r*" } }) }));
    const shown = started?.kind === "call" ? started.value : undefined;
    assert.deepEqual(shown ? { tool: shown.tool, name: shown.name, params: json((shown.params.value ?? {}) as never) } : null, { tool: ClientSideToolV2.GET_MCP_TOOLS, name: "GetMcpTools", params: { server: "srv", toolName: "run", pattern: "r*" } });
    // Discovery needs no arguments beyond having been called at all.
    assert.equal(projectAgentToolCallToClientSideToolV2("toolCallStarted", "call-1", call({ case: "getMcpToolsToolCall", value: new GetMcpToolsToolCall({ args: {} }) }))?.kind, "call");
    assert.equal(projectAgentToolCallToClientSideToolV2("toolCallStarted", "call-1", call({ case: "getMcpToolsToolCall", value: new GetMcpToolsToolCall({}) })), null);
    const answer = projectAgentToolCallToClientSideToolV2("toolCallCompleted", "call-1", call({ case: "getMcpToolsToolCall", value: new GetMcpToolsToolCall({ result: new GetMcpToolsAgentResult({ result: { case: "success", value: new GetMcpToolsSuccess({ content: "tools", outputFilePath: "/tmp/tools" }) } }) }) }));
    assert.deepEqual(answer?.kind === "result" ? json((answer.value.result.value ?? {}) as never) : null, { content: "tools", outputFilePath: "/tmp/tools" });

    // A read shows the caller's own name for the tool when it has one, and does not carry an empty directory.
    const readWithName = projectAgentToolCallToClientSideToolV2("toolCallStarted", "call-1", call({ case: "readToolCall", value: new ReadToolCall({ args: { path: "src/a.ts" } }) }), "", "Document");
    assert.equal(readWithName?.kind === "call" ? readWithName.value.name : null, "Document");
    const shellWithoutDirectory = projectAgentToolCallToClientSideToolV2("toolCallStarted", "call-1", call({ case: "shellToolCall", value: new ShellToolCall({ args: { command: "ls", workingDirectory: "" } }) }));
    assert.deepEqual(shellWithoutDirectory?.kind === "call" ? json((shellWithoutDirectory.value.params.value ?? {}) as never) : null, { command: "ls", requireUserApproval: true });
  });
});
