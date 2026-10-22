import assert from "node:assert/strict";
import { describe, it } from "node:test";

import {
  SUPPORTED_SCHEMA_IDS,
  extractSchemaVersion,
  readSchemaId,
  resolveSchemaVersion,
  schemaVersionsDisagree,
} from "../../source/packages/plugin-install/schema-version.ts";

describe("the schema a plugin's manifest declares", () => {
  it("is the two schema ids this platform can read", () => {
    assert.deepEqual([...SUPPORTED_SCHEMA_IDS].sort(), [
      "https://agent-plugins.org/schemas/1.0.0/mcp.schema.json",
      "https://agent-plugins.org/schemas/1.0.0/plugin.schema.json",
    ]);
    assert.equal(SUPPORTED_SCHEMA_IDS instanceof Set, true);
  });

  it("is read from the manifest's schema field only when it says something", () => {
    assert.equal(readSchemaId({ $schema: "https://x/schema.json" }), "https://x/schema.json");
    assert.equal(readSchemaId({ $schema: "" }), undefined);
    assert.equal(readSchemaId({ $schema: 7 }), undefined);
    assert.equal(readSchemaId({}), undefined);
    assert.equal(readSchemaId(null), undefined);
    assert.equal(readSchemaId([]), undefined);
    assert.equal(readSchemaId(Object.assign([], { $schema: "on-an-array" })), undefined, "an array is not a manifest");
    assert.equal(readSchemaId(Object.create({ $schema: "inherited" })), "inherited", "a field can be inherited");
  });

  it("names its version by the first path segment that is one", () => {
    assert.equal(extractSchemaVersion("https://agent-plugins.org/schemas/1.0.0/plugin.schema.json"), "1.0.0");
    assert.equal(extractSchemaVersion("https://x/schemas/v1.2/plugin.schema.json"), "1.2");
    assert.equal(extractSchemaVersion("https://x/a/1.2.3/b"), "1.2.3");
    assert.equal(extractSchemaVersion("https://x/a/1.2/b/2.0/c"), "1.2", "the first version in the path wins");
    assert.equal(extractSchemaVersion("https://x/a/b"), undefined);
    assert.equal(extractSchemaVersion("not a url/1.2/x"), "1.2", "a text that is not a URL is split by its slashes");
    assert.equal(extractSchemaVersion("a/b/1.2/c"), "1.2");
    assert.equal(extractSchemaVersion("https://x/a/V1.2/b"), undefined, "the v prefix is lower-case only");
    assert.equal(extractSchemaVersion("https://x/a/1.2.3.4/b"), undefined, "three parts at most");
    assert.equal(extractSchemaVersion("https://x/a/x1.2/b"), undefined, "the whole segment has to be the version");
  });

  it("resolves to absent, supported or unsupported", () => {
    assert.deepEqual(resolveSchemaVersion(undefined), { kind: "absent" });
    assert.deepEqual(resolveSchemaVersion("https://agent-plugins.org/schemas/1.0.0/plugin.schema.json"), {
      kind: "supported",
      id: "https://agent-plugins.org/schemas/1.0.0/plugin.schema.json",
      version: "1.0.0",
    });
    assert.deepEqual(resolveSchemaVersion("https://elsewhere.example/schema.json"), {
      kind: "unsupported",
      id: "https://elsewhere.example/schema.json",
    });
    assert.deepEqual(resolveSchemaVersion(null as never), { kind: "unsupported", id: null }, "a null id is not an absent one");
  });

  it("disagrees only when both declare a version and the versions differ", () => {
    const plugin = "https://agent-plugins.org/schemas/1.0.0/plugin.schema.json";
    const mcp = "https://agent-plugins.org/schemas/1.0.0/mcp.schema.json";
    const newer = "https://agent-plugins.org/schemas/2.0.0/plugin.schema.json";
    assert.equal(schemaVersionsDisagree(plugin, mcp), false);
    assert.equal(schemaVersionsDisagree(plugin, newer), true);
    assert.equal(schemaVersionsDisagree(plugin, undefined), false);
    assert.equal(schemaVersionsDisagree(undefined, mcp), false);
    assert.equal(schemaVersionsDisagree("https://x/a/b", "https://x/c/d"), false);
    assert.equal(schemaVersionsDisagree("https://x/a/1.2/b", "https://y/c/2.0/d"), true);
  });
});