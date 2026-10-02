/**
 * The MCP results the platform builds: a text item, a success that keeps what the original carried, and an error —
 * shaped the one way so every tool result looks like the platform's own.
 */

import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { generatedMcpResultFactory } from "../../source/shared/node/mcp/mcp-result-factory.ts";
import { McpResult, McpSuccess } from "../../source/packages/proto/generated/agent/v1/mcp_exec_pb.ts";

describe("the MCP result factory", () => {
  it("builds a text item as the platform's own content item", () => {
    const item = generatedMcpResultFactory.textItem("what the tool said");
    assert.deepEqual(item.content.case, "text");
    assert.deepEqual((item.content.value as { text: string }).text, "what the tool said");
  });

  it("builds a success that keeps what the original result carried", () => {
    // What the original carried is what comes back, so the same value is handed through rather than rebuilt.
    const structured = { fields: {} } as never;
    const original = new McpResult({
      result: {
        case: "success",
        value: new McpSuccess({ content: [], isError: true, structuredContent: structured }),
      },
    });
    const success = generatedMcpResultFactory.success(original, [
      generatedMcpResultFactory.textItem("after"),
    ]);
    assert.deepEqual(success.result.case, "success");
    const value = success.result.value as McpSuccess;
    assert.deepEqual(value.content.map((item) => (item.content.value as { text: string }).text), ["after"]);
    // What the original said about the turn is what the result still says.
    // The result is a message of the platform's own making, so what it carried is carried as that kind of value.
    assert.deepEqual([value.isError, value.structuredContent != null, value.content.length], [true, true, 1]);
    // A result that said nothing about being an error is not one, and nothing is invented for it.
    const plain = generatedMcpResultFactory.success(
      new McpResult({ result: { case: "success", value: new McpSuccess({ content: [] }) } }),
      [],
    );
    const plainValue = plain.result.value as McpSuccess;
    assert.deepEqual([plainValue.isError, plainValue.structuredContent, value.content.length], [false, undefined, 1]);
  });

  it("builds an error as the platform's own error result", () => {
    const error = generatedMcpResultFactory.error("the tool refused");
    assert.deepEqual(error.result.case, "error");
    assert.deepEqual(error.result.value, new McpResult({ result: { case: "error", value: { error: "the tool refused" } as never } }).result.value);
    assert.deepEqual((error.result.value as { error: string }).error, "the tool refused");
  });
});
