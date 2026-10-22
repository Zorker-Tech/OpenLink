import assert from "node:assert/strict";
import { describe, it } from "node:test";

import {
  McpExecToolNotFoundError,
  McpInvalidArgsToolDefinitionReminderError,
  McpPermissionDeniedError,
  McpServerDoesNotExistError,
  McpToolDoesNotExistError,
  McpWithoutReadToolDefinitionError,
  convertExecSuccessToToolSuccess,
  createMcpToolCall,
  createMcpTransportError,
  createVirtualMcpAuthSuccessResult,
  getWrappedMcpErrorClassification,
  isInvalidMcpArgumentsError,
  renderMcpToolResult,
} from "../../source/packages/agent/tools/mcp/mcp-result-boundary.ts";
import { ASK_MODE_MODEL_ERROR } from "../../source/packages/agent/tools/tool-support.ts";
import { CustomToolCallError, ToolErrorClassification } from "../../source/packages/agent/tools/tool-errors.ts";
import {
  McpError,
  McpPermissionDenied,
  McpRejected,
  McpResult,
  McpServerNotFound,
  McpSuccess,
  McpTextContent,
  McpToolNotFound,
  McpToolResultContentItem,
} from "../../source/packages/proto/generated/agent/v1/mcp_exec_pb.ts";
import { McpToolCall, McpToolResult } from "../../source/packages/proto/generated/agent/v1/mcp_tool_pb.ts";

const textItem = (text: string, location?: { filePath: string; sizeBytes: number; lineCount: number }) => new McpToolResultContentItem({
  content: { case: "text", value: new McpTextContent({ text, ...(location === undefined ? {} : { outputLocation: location as never }) }) },
});
const successResult = (content: McpToolResultContentItem[], isError = false) => new McpResult({ result: { case: "success", value: new McpSuccess({ content, isError }) } });
const toolResult = (result: any) => new McpToolResult({ result } as never);

describe("turning an MCP answer into a tool answer", () => {
  it("describes each failure the way its audience needs it", () => {
    const denied = new McpPermissionDeniedError("cannot write", false);
    assert.deepEqual([denied.message, denied.classification, denied.error, denied.isReadonly, denied.clientVisibleErrorMessage, denied.modelVisibleErrorMessage], ["cannot write", ToolErrorClassification.UNEXPECTED_ENVIRONMENT, "cannot write", false, "Permission denied: cannot write", "Permission denied: cannot write"]);
    const readonly = new McpPermissionDeniedError("cannot write", true);
    assert.equal(readonly.clientVisibleErrorMessage, ASK_MODE_MODEL_ERROR);
    assert.equal(readonly.modelVisibleErrorMessage, ASK_MODE_MODEL_ERROR);
    const server = new McpServerDoesNotExistError("server-1", "read the descriptor");
    assert.deepEqual([server.message, server.serverIdentifier, server.readServerDefReminder, server.modelVisibleErrorMessage], ["MCP server does not exist: server-1", "server-1", "read the descriptor", "MCP server does not exist: server-1. read the descriptor"]);
    const tool = new McpToolDoesNotExistError("server-1", "tool-1", "read the definition");
    assert.deepEqual([tool.message, tool.clientVisibleErrorMessage, tool.modelVisibleErrorMessage, tool.toolName], ["MCP tool does not exist: server=server-1, tool=tool-1", "MCP tool does not exist: tool-1", "unused", "tool-1"]);
    assert.equal(new McpExecToolNotFoundError("gone").classification, ToolErrorClassification.UNEXPECTED_ENVIRONMENT);
    const withoutRead = new McpWithoutReadToolDefinitionError(new Error("boom"), "read it");
    assert.deepEqual([withoutRead.message, withoutRead.classification, withoutRead.modelVisibleErrorMessage, withoutRead.error], ["Error in call_mcp_tool: boom without reading the tool definition", ToolErrorClassification.OTHER_ERROR, "boom. read it", withoutRead.error]);
    const invalid = new McpInvalidArgsToolDefinitionReminderError(new Error("bad args"), "read it");
    assert.deepEqual([invalid.message, invalid.classification, invalid.modelVisibleErrorMessage], ["bad args", ToolErrorClassification.INVALID_ARGS, "bad args. read it"]);
  });

  it("classifies errors and transport failures", () => {
    assert.equal(getWrappedMcpErrorClassification(new McpPermissionDeniedError("x", false)), ToolErrorClassification.UNEXPECTED_ENVIRONMENT);
    assert.equal(getWrappedMcpErrorClassification(new Error("x")), ToolErrorClassification.OTHER_ERROR);
    assert.equal(isInvalidMcpArgumentsError(new McpInvalidArgsToolDefinitionReminderError(new Error("x"), "r")), true);
    assert.equal(isInvalidMcpArgumentsError(new Error("x")), false);
    const classified = createMcpTransportError("unauthorized");
    assert.equal(classified instanceof CustomToolCallError, true);
    assert.equal((classified as CustomToolCallError).clientVisibleErrorMessage, "unauthorized");
    const cause = new Error("cause");
    const plain = createMcpTransportError("something odd", cause);
    assert.deepEqual([plain.name, plain.message, (plain as { cause?: unknown }).cause], ["Error", "something odd", cause]);
    assert.equal(createMcpTransportError("something odd") instanceof CustomToolCallError, false);
  });

  it("wraps a tool call for the turn", () => {
    const mcpCall = new McpToolCall({ name: "tool-1", serverIdentifier: "server-1" } as never);
    const call = createMcpToolCall(mcpCall);
    assert.deepEqual([call.tool.case, call.tool.value], ["mcpToolCall", mcpCall]);
  });

  it("converts every exec answer, or throws the error the model should act on", () => {
    const success = convertExecSuccessToToolSuccess(successResult([textItem("hello")]), undefined, undefined, undefined, undefined);
    const successItem = (success.result.value as McpSuccess).content[0]!;
    assert.deepEqual([success.result.case, successItem.content.case, successItem.content.case === "text" ? successItem.content.value.text : undefined], ["success", "text", "hello"]);
    assert.throws(() => convertExecSuccessToToolSuccess(new McpResult({ result: { case: "error", value: new McpError({ error: "plain failure" }) } }), undefined, undefined, undefined, undefined), { message: "plain failure", name: "Error" });
    assert.throws(() => convertExecSuccessToToolSuccess(new McpResult({ result: { case: "error", value: new McpError({ error: "plain failure" }) } }), "read the definition", undefined, undefined, undefined), McpWithoutReadToolDefinitionError);
    assert.throws(() => convertExecSuccessToToolSuccess(new McpResult({ result: { case: "rejected", value: new McpRejected({}) } }), undefined, undefined, undefined, undefined), { message: "Tool rejected" });
    assert.throws(() => convertExecSuccessToToolSuccess(new McpResult({ result: { case: "rejected", value: new McpRejected({ reason: "not now" }) } }), undefined, undefined, undefined, undefined), { message: "not now" });
    assert.throws(() => convertExecSuccessToToolSuccess(new McpResult({ result: { case: "permissionDenied", value: new McpPermissionDenied({ error: "cannot write", isReadonly: true }) } }), undefined, undefined, undefined, undefined), (error: McpPermissionDeniedError) => { assert.equal(error.isReadonly, true); assert.equal(error.clientVisibleErrorMessage, ASK_MODE_MODEL_ERROR); return true; });
    // A missing tool whose whole server is missing answers with the servers instead.
    assert.throws(() => convertExecSuccessToToolSuccess(new McpResult({ result: { case: "toolNotFound", value: new McpToolNotFound({ name: "tool-1", availableTools: ["other-a"] }) } }), undefined, undefined, undefined, "FindMcp", "server-1"), McpServerDoesNotExistError);
    assert.throws(() => convertExecSuccessToToolSuccess(new McpResult({ result: { case: "toolNotFound", value: new McpToolNotFound({ name: "tool-1", availableTools: ["server-1-a"] }) } }), undefined, undefined, undefined, undefined, "server-1"), McpExecToolNotFoundError);
    assert.throws(() => convertExecSuccessToToolSuccess(new McpResult({ result: { case: "toolNotFound", value: new McpToolNotFound({ name: "tool-1" }) } }), undefined, undefined, undefined, "FindMcp"), { message: "Tool tool-1 was not found. Use FindMcp to discover available servers and their tools." });
    assert.throws(() => convertExecSuccessToToolSuccess(new McpResult({ result: { case: "toolNotFound", value: new McpToolNotFound({ name: "tool-1" }) } }), undefined, undefined, { enabled: true, workspaceProjectDir: "/work" }, undefined), { message: "Tool tool-1 was not found. The list of all available MCP servers are included in /work/mcps. Please list and read the relevant MCP servers carefully before using call_mcp_tool again." });
    assert.throws(() => convertExecSuccessToToolSuccess(new McpResult({ result: { case: "serverNotFound", value: new McpServerNotFound({ name: "server-1", availableServers: ["a", "b"] }) } }), undefined, undefined, undefined, undefined), (error: McpServerDoesNotExistError) => { assert.equal(error.readServerDefReminder, "Available servers: a, b"); return true; });
    assert.throws(() => convertExecSuccessToToolSuccess(new McpResult({ result: { case: "serverNotFound", value: new McpServerNotFound({ name: "server-1" }) } }), undefined, undefined, undefined, "FindMcp"), (error: Error) => {
      assert.equal((error as McpServerDoesNotExistError).readServerDefReminder, "No MCP servers available. Use FindMcp to discover available servers.");
      return true;
    });
    assert.throws(() => convertExecSuccessToToolSuccess(new McpResult({}), undefined, undefined, undefined, undefined), { message: "Exec result has no case" });
  });

  it("renders a sign-in and a tool result for the model", () => {
    const auth = createVirtualMcpAuthSuccessResult("server-1");
    const authItem = (auth.result.value as McpSuccess).content[0]!;
    assert.deepEqual([auth.result.case, authItem.content.case === "text" ? authItem.content.value.text : undefined, (auth.result.value as McpSuccess).isError], ["success", "Successfully authenticated MCP server: server-1. The server's tools should now be available.", false]);
    assert.deepEqual(renderMcpToolResult(toolResult({ case: "success", value: new McpSuccess({ content: [textItem("hello")], isError: true }) })), { content: [{ type: "text", text: "hello" }], isError: true });
    assert.deepEqual(renderMcpToolResult(toolResult({ case: "success", value: new McpSuccess({ content: [textItem("", { filePath: "/tmp/out.txt", sizeBytes: 2_048, lineCount: 7 })] }) })), { content: [{ type: "text", text: "Large output has been written to: /tmp/out.txt (2.0 KB, 7 lines)" }], isError: false });
    assert.deepEqual(renderMcpToolResult(toolResult({ case: "success", value: new McpSuccess({ content: [textItem("", { filePath: "/tmp/out.txt", sizeBytes: 1_023, lineCount: 1 })] }) })), { content: [{ type: "text", text: "Large output has been written to: /tmp/out.txt (1023 bytes, 1 lines)" }], isError: false });
    assert.deepEqual(renderMcpToolResult(toolResult({ case: "success", value: new McpSuccess({ content: [new McpToolResultContentItem({ content: { case: "image", value: { data: new Uint8Array([1, 2, 3]), mimeType: "image/png" } as never } })] }) })), { content: [{ type: "image", data: Buffer.from(new Uint8Array([1, 2, 3])).toString("base64"), mimeType: "image/png" }], isError: false });
    assert.deepEqual(renderMcpToolResult(toolResult({ case: "rejected", value: new McpRejected({}) })), { content: [{ type: "text", text: "Tool rejected" }] });
    assert.deepEqual(renderMcpToolResult(toolResult({ case: "rejected", value: new McpRejected({ reason: "not now" }) })), { content: [{ type: "text", text: "Tool rejected: not now" }] });
    assert.deepEqual(renderMcpToolResult(toolResult({ case: "permissionDenied", value: new McpPermissionDenied({ error: "cannot write", isReadonly: true }) })), { content: [{ type: "text", text: ASK_MODE_MODEL_ERROR }] });
    assert.deepEqual(renderMcpToolResult(new McpToolResult({})), { content: [{ type: "text", text: "Unknown error" }] });
    assert.throws(() => renderMcpToolResult({ result: { case: "weird", value: {} } } as never), { message: /Unhandled result case/ });
  });
});