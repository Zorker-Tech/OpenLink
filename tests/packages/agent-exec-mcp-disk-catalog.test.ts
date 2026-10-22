import assert from "node:assert/strict";
import { describe, it } from "node:test";

import {
  MCP_DISK_CATALOG_MCPS_DIR,
  MCP_DISK_CATALOG_TOOLS_DIR,
  parseMcpToolNameFromDiskDefinitionJson,
} from "../../source/packages/agent-exec/mcp-disk-catalog.ts";

const parse = (value: unknown) => parseMcpToolNameFromDiskDefinitionJson(JSON.stringify(value));
const parseText = (jsonText: string) => parseMcpToolNameFromDiskDefinitionJson(jsonText);

describe("the disk catalogue's layout", () => {
  it("names the two directories the store keeps", () => {
    assert.equal(MCP_DISK_CATALOG_MCPS_DIR, "mcps");
    assert.equal(MCP_DISK_CATALOG_TOOLS_DIR, "tools");
  });
});

describe("the name in a stored tool definition", () => {
  it("is the tool's own name, or the older field that carried it", () => {
    assert.equal(parse({ name: "create_issue" }), "create_issue");
    assert.equal(parse({ toolName: "list_issues" }), "list_issues");
    assert.equal(parse({ name: "create_issue", toolName: "list_issues" }), "create_issue", "the tool's own name wins");
  });

  it("falls through an empty or non-text name to the older field", () => {
    assert.equal(parse({ name: "", toolName: "list_issues" }), "list_issues");
    assert.equal(parse({ name: 7, toolName: "list_issues" }), "list_issues");
    assert.equal(parse({ name: null, toolName: "list_issues" }), "list_issues");
    assert.equal(parse({ name: "" }), undefined);
    assert.equal(parse({ toolName: "" }), undefined);
    assert.equal(parse({ name: 7, toolName: 8 }), undefined);
  });

  it("is absent when there is no name in the file", () => {
    assert.equal(parse({}), undefined);
    assert.equal(parse({ title: "not a name" }), undefined);
    assert.equal(parse({ definition: { name: "nested" } }), undefined);
    assert.equal(parse({ name: ["a"] }), undefined, "a list is not a name");
  });

  it("keeps the name exactly as stored", () => {
    assert.equal(parse({ name: " spaced name " }), " spaced name ");
    assert.equal(parse({ name: "créer ☕" }), "créer ☕");
    assert.equal(parse({ name: "a".repeat(500) }), "a".repeat(500));
  });

  it("is absent when the file is not JSON, or is JSON that is not an object", () => {
    for (const jsonText of ["not json", "", "null", "true", "42", '"name"', "[]", '[{"name":"x"}]']) {
      assert.equal(parseText(jsonText), undefined, jsonText);
    }
  });
});
