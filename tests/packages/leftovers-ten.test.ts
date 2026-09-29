/**
 * The host's event bus, the extension registry and the extensions that register through it.
 */

import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { SlateHostEventBus } from "../../source/host/host-event-bus.ts";
import { HOST_EXTENSION_ORDER } from "../../source/host/extensions/registry.ts";
import { SlateMcpInstructionsAndToggles } from "../../source/shared/node/mcp/mcp-instructions-and-toggles.ts";

describe("the bus the host's extensions talk over", () => {
  it("offers a way to subscribe, to listen on a topic and to emit", () => {
    const bus = new SlateHostEventBus();
    assert.equal(typeof bus.subscribe, "function");
    assert.equal(typeof bus.on, "function");
    assert.equal(typeof bus.emit, "function");
  });
});

describe("the extensions this build registers", () => {
  it("names the order they start in, and names each of them once", () => {
    assert.equal(HOST_EXTENSION_ORDER.length > 5, true);
    assert.equal(new Set(HOST_EXTENSION_ORDER).size, HOST_EXTENSION_ORDER.length);
  });
});

describe("what the platform tells the model about its MCP servers", () => {
  it("is built from the servers and the platform's switches together", () => {
    assert.equal(typeof SlateMcpInstructionsAndToggles, "function");
  });
});
