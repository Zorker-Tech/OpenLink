import assert from "node:assert/strict";
import { describe, it } from "node:test";

import {
  SLATE_BOX_AWAIT_SHELL_TOOL_NAME,
  SLATE_BOX_READ_TOOL_NAME,
  SLATE_BOX_SHELL_TOOL_NAME,
  SLATE_DEFAULT_EXTERNAL_MACHINE_ID,
  SLATE_EXTERNAL_AWAIT_SHELL_TOOL_NAME,
  SLATE_EXTERNAL_MACHINES,
  SLATE_EXTERNAL_READ_TOOL_NAME,
  SLATE_EXTERNAL_SHELL_TOOL_NAME,
  SLATE_USER_COMPUTER,
  resolveSlateExternalMachine,
  slateDualSurfaceToolTelemetry,
} from "../../source/shared/agents/agent-tool-names.ts";

describe("the names the platform's own tools are known by", () => {
  it("pairs each tool with the surface it runs on", () => {
    assert.equal(slateDualSurfaceToolTelemetry(SLATE_BOX_SHELL_TOOL_NAME)?.surface, "box");
    assert.equal(slateDualSurfaceToolTelemetry(SLATE_BOX_READ_TOOL_NAME)?.surface, "box");
    assert.equal(slateDualSurfaceToolTelemetry(SLATE_BOX_AWAIT_SHELL_TOOL_NAME)?.surface, "box");
    assert.equal(slateDualSurfaceToolTelemetry(SLATE_EXTERNAL_SHELL_TOOL_NAME)?.surface, "external");
    assert.equal(slateDualSurfaceToolTelemetry(SLATE_EXTERNAL_READ_TOOL_NAME)?.surface, "external");
    assert.equal(slateDualSurfaceToolTelemetry(SLATE_EXTERNAL_AWAIT_SHELL_TOOL_NAME)?.surface, "external");
  });

  it("says nothing about a tool that is not one of ours, or about a name every object has", () => {
    for (const tool of ["Other", "", "toString", "__proto__", "constructor", "hasOwnProperty"]) {
      assert.equal(slateDualSurfaceToolTelemetry(tool), undefined, tool);
    }
  });

  it("keeps the tool's own name in what it reports", () => {
    assert.deepEqual(slateDualSurfaceToolTelemetry(SLATE_BOX_SHELL_TOOL_NAME), { toolName: "Shell", surface: "box" });
  });
});

describe("the machines a tool may run on", () => {
  it("knows the user's own computer, by id and by its own entry", () => {
    assert.equal(SLATE_DEFAULT_EXTERNAL_MACHINE_ID, "user-computer");
    assert.deepEqual(SLATE_USER_COMPUTER, { id: "user-computer", label: "the user's computer" });
    assert.deepEqual(SLATE_EXTERNAL_MACHINES["user-computer"], SLATE_USER_COMPUTER);
  });

  it("resolves the computer it knows, from an id or with none given", () => {
    assert.equal(resolveSlateExternalMachine("user-computer"), SLATE_USER_COMPUTER);
    assert.equal(resolveSlateExternalMachine(), SLATE_USER_COMPUTER);
  });

  it("does not invent a machine it does not know", () => {
    for (const id of ["some-machine", "", "…"]) assert.equal(resolveSlateExternalMachine(id), undefined, id);
    // Pinned as it is, not as it should be: the machines are a plain record, so a name every object has comes back as
    // that member rather than as nothing. A caller asking for a machine by an id from outside gets a function here.
    // Recorded as debt in docs/architecture/work-reference-mapping.md rather than quietly changed in a rewrite pass.
    assert.equal(typeof resolveSlateExternalMachine("toString"), "function");
  });
});
