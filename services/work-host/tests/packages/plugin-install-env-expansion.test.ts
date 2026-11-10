import assert from "node:assert/strict";
import { describe, it } from "node:test";

import {
  expandEnvVarsWithLookup,
  recordToCaseInsensitiveLookup,
} from "../../source/packages/plugin-install/env-expansion.ts";

const variables = { NAME: "world", EMPTY: "", VALUE: "x" };

describe("a case-insensitive variable lookup", () => {
  it("answers the exact name first, then the folded one", () => {
    const lookup = recordToCaseInsensitiveLookup({ FOO: "one", bar: "two" });
    assert.equal(lookup("FOO"), "one");
    assert.equal(lookup("foo"), "one");
    assert.equal(lookup("BAR"), "two");
    assert.equal(lookup("missing"), undefined);
  });

  it("keeps the exact spelling's value when two names fold together", () => {
    const lookup = recordToCaseInsensitiveLookup({ KEY: "upper", key: "lower" });
    assert.equal(lookup("KEY"), "upper", "the exact match wins");
    assert.equal(lookup("key"), "lower");
    assert.equal(lookup("Key"), "lower", "the folded map keeps the last spelling built");
  });

  it("keeps an empty value as an answer", () => {
    assert.equal(recordToCaseInsensitiveLookup({ EMPTY: "" })("empty"), "");
  });
});

describe("expanding a configuration's variables", () => {
  it("resolves a variable, its default, and leaves an unresolved one as written", () => {
    assert.equal(expandEnvVarsWithLookup("a ${NAME} b", variables), "a world b");
    assert.equal(expandEnvVarsWithLookup("${MISSING}", variables), "${MISSING}", "an unresolved variable is better seen than emptied");
    assert.equal(expandEnvVarsWithLookup("${MISSING:-fallback}", variables), "fallback");
    assert.equal(expandEnvVarsWithLookup("${MISSING:-}", variables), "");
    assert.equal(expandEnvVarsWithLookup("${EMPTY:-fallback}", variables), "", "an empty answer is still an answer");
    assert.equal(expandEnvVarsWithLookup("${NAME:-fallback}", variables), "world");
    assert.equal(expandEnvVarsWithLookup("no variables here", variables), "no variables here");
    assert.equal(expandEnvVarsWithLookup("${} ${:x} ${NAME:}", variables), "${} ${:x} ${NAME:}", "only the marker's shape counts as a variable");
    assert.equal(expandEnvVarsWithLookup("${MISSING:-{x}}", variables), "{x}", "the default stops at the first closing brace");
  });

  it("accepts a lookup function as well as a record", () => {
    assert.equal(expandEnvVarsWithLookup("${A}", () => "from function"), "from function");
    assert.equal(expandEnvVarsWithLookup("${a}", { A: "from record" }), "from record");
  });

  it("walks lists and objects, building new containers", () => {
    const input = { title: "${NAME}", list: ["${VALUE}", 2], nested: { deeper: "${MISSING:-done}" } };
    const output = expandEnvVarsWithLookup(input, variables);
    assert.deepEqual(output, { title: "world", list: ["x", 2], nested: { deeper: "done" } });
    assert.notEqual(output, input);
    assert.notEqual(output.list, input.list);
    assert.deepEqual(input, { title: "${NAME}", list: ["${VALUE}", 2], nested: { deeper: "${MISSING:-done}" } }, "the input is not changed");
  });

  it("leaves the values that are not strings, lists or objects alone", () => {
    for (const value of [42, true, null, undefined, 12n]) {
      assert.equal(expandEnvVarsWithLookup(value, variables), value);
    }
    const fn = () => "f";
    assert.equal(expandEnvVarsWithLookup(fn, variables), fn);
  });

  it("keeps the key order of an object it walks", () => {
    assert.deepEqual(Object.keys(expandEnvVarsWithLookup({ z: 1, a: "${NAME}", m: 3 }, variables) as object), ["z", "a", "m"]);
  });
});
