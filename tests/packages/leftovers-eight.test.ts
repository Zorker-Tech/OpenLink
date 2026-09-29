/**
 * The MCP servers the platform ships and the two coordinator ports: the one the renderer reaches it on
 * and the one it uses to reach the host.
 */

import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { BOX_COMPUTER_SERVER_NAME, BUILTIN_MCP_SERVER_NAMES, DEFAULT_BOX_CONTAINER_NAME, LOCAL_DOCKER_HOST_SENTINEL } from "../../source/shared/node/mcp/builtin-mcp.ts";
import { ControlPortCallError, createControlPortClient } from "../../source/coordinator/control-port-client.ts";
import { createRendererPortServer } from "../../source/coordinator/renderer-port-server.ts";

describe("the MCP servers the platform ships", () => {
  it("names the box computer's server and the container it runs in after us", () => {
    assert.equal(BOX_COMPUTER_SERVER_NAME, "slate-box-computer");
    assert.equal(DEFAULT_BOX_CONTAINER_NAME, "slate-box-shared");
    assert.deepEqual([...BUILTIN_MCP_SERVER_NAMES], ["slate-box-computer"]);
    assert.equal(typeof LOCAL_DOCKER_HOST_SENTINEL, "string");
  });
});

describe("the port the renderer reaches the coordinator on", () => {
  it("is created by the coordinator rather than imported for effect", () => {
    assert.equal(typeof createRendererPortServer, "function");
  });
});

describe("the client the coordinator uses to reach the host", () => {
  it("names the error a failed call raises", () => {
    const error = new ControlPortCallError("no answer", "timeout" as never);
    assert.equal(error instanceof Error, true);
    assert.equal(typeof createControlPortClient, "function");
  });
});
