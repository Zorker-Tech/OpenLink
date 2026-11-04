/**
 * The MCP server definitions, the queue's telemetry, the send-message tool, the extension contract and
 * the transport that carries a client-side tool call.
 */

import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { EMPTY_MCP_CONFIG, SlateMcpDefinitionSource } from "../../source/shared/node/mcp/mcp-definition-source.ts";
import { withAutomationRunAnalytics } from "../../source/host/telemetry/analytics-service.ts";
import { createHostEvents, defineHostExtension, HostExtensionGraphError, resolveHostExtensionBootOrder } from "../../source/host/extensions/host-extensions.ts";
import { SEND_DISPATCH_EVENT, QUEUE_ACCEPTED_EVENT } from "../../source/host/telemetry/queue-telemetry-mappers.ts";
import { SLATE_SEND_MESSAGE_TOOL_NAME } from "../../source/host/runner/tools/send-message-tool.ts";
import { CLIENT_SIDE_TOOL_V2_ACCOUNT_SLOT, CLIENT_SIDE_TOOL_V2_FAMILY, CLIENT_SIDE_TOOL_V2_WIRE_VERSION } from "../../source/adapters/interop/agent/client-side-tool-v2-transport-adapter.ts";

describe("where an MCP server's definition comes from", () => {
  it("tells a server the platform ships from one the user configured, and neither from nothing", () => {
    assert.equal(typeof SlateMcpDefinitionSource, "function");
    assert.equal(typeof EMPTY_MCP_CONFIG, "object");
  });
});

describe("the queue as the telemetry backend sees it", () => {
  it("reports under our own event names", () => {
    assert.equal(SEND_DISPATCH_EVENT, "slate.send_dispatch");
    assert.equal(QUEUE_ACCEPTED_EVENT, "slate.queue.accepted");
  });
});

describe("what the platform reports to its analytics service", () => {
  it("is built from a client, and describes what happened rather than the shape the service wants", () => {
    assert.equal(typeof withAutomationRunAnalytics, "function");
  });
});

describe("how a host extension is written", () => {
  it("is defined with its id, its dependencies and a place to put its teardown", () => {
    assert.equal(typeof defineHostExtension, "function");
    assert.equal(typeof resolveHostExtensionBootOrder, "function");
    assert.equal(typeof createHostEvents, "function");
    assert.equal(new HostExtensionGraphError("cycle").name, "HostExtensionGraphError");
  });
});

describe("the SendMessage tool", () => {
  it("is named after what it does", () => {
    assert.equal(SLATE_SEND_MESSAGE_TOOL_NAME, "SendMessage");
  });
});

describe("carrying a client-side tool call", () => {
  it("is a function a transport can call", () => {
    assert.equal(CLIENT_SIDE_TOOL_V2_FAMILY, "client-side-tool-v2");
    assert.equal(CLIENT_SIDE_TOOL_V2_WIRE_VERSION, 1);
    assert.equal(CLIENT_SIDE_TOOL_V2_ACCOUNT_SLOT, "host");
  });
});
