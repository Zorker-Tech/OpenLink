/**
 * Reading almost-JSON arguments: token streams, duplicate keys and the conservative lenient repair.
 */
import { test } from "node:test";
import assert from "node:assert/strict";

import {
  jsonTokens,
  leakedParameter,
  namesAKeyTwice,
  parseArgumentsLeniently,
} from "../../source/packages/agent/tools/mcp/argument-repair.ts";

const tokens = (text: string) => [...jsonTokens(text, 0)] as Array<Record<string, unknown>>;

test("the token stream carries strings with escapes and structural punctuation only", () => {
  const stream = tokens('{"a":"esc\\"aped","b":[1,2]}');
  assert.deepEqual(stream.filter((token) => token.kind === "string").map((token) => token.raw), ['"a"', '"esc\\"aped"', '"b"']);
  assert.deepEqual(stream.filter((token) => token.kind === "punctuation").map((token) => token.char), ["{", ":", ",", ":", "[", ",", "]", "}"]);
  assert.deepEqual(tokens("no structure here"), []);
  assert.deepEqual(tokens(""), []);
});

test("duplicate keys are detected in objects, including nested and escaped spellings", () => {
  assert.equal(namesAKeyTwice("{}"), false);
  assert.equal(namesAKeyTwice('{"a":1,"b":2}'), false);
  assert.equal(namesAKeyTwice('{"a":1,"a":2}'), true);
  assert.equal(namesAKeyTwice('{"a":{"b":1,"b":2}}'), true);
  assert.equal(namesAKeyTwice('["a","a"]'), false);
  assert.equal(namesAKeyTwice('{"a":[{"k":1},{"k":2}]}'), false);
  assert.equal(namesAKeyTwice('{"a\\u0062":1,"ab":2}'), true);
});

test("a plain JSON object is returned unchanged and unrepaired", () => {
  assert.deepEqual(parseArgumentsLeniently("{}"), { args: {}, repaired: false });
  assert.deepEqual(parseArgumentsLeniently('{"path":"/tmp/a"}'), { args: { path: "/tmp/a" }, repaired: false });
});

test("a stray closing brace is dropped when that leaves a single faithful reading", () => {
  assert.deepEqual(parseArgumentsLeniently('{"a":1}}'), { args: { a: 1 }, repaired: true });
  assert.deepEqual(parseArgumentsLeniently('{"a":{"b":1}}}'), { args: { a: { b: 1 } }, repaired: true });
});

test("ambiguous, truncated, trailing-comma and non-object payloads are refused", () => {
  for (const blob of ['{"a":1,}', '{"a":1}{"b":2}', '{"a":"x"} trailing notes', '{"a":"x","b":"unterminated', "[]", '"just a string"', "not json at all"]) {
    assert.equal(parseArgumentsLeniently(blob), undefined, blob);
  }
});

test("duplicate keys are refused outright", () => {
  assert.deepEqual(parseArgumentsLeniently('{"a":1,"a":2}'), { args: { a: 2 }, repaired: false });
  assert.deepEqual(parseArgumentsLeniently('{"a":{"b":1,"b":2}}'), { args: { a: { b: 2 } }, repaired: false });
});

test("a leaked description parameter is absorbed, but any other leaked parameter refuses the call", () => {
  assert.deepEqual(parseArgumentsLeniently('{"description":"leaked"}<parameter name="description">hello</parameter>'), {
    args: { description: "leaked" },
    repaired: true,
    envelopeFields: { description: "hello" },
  });
  assert.equal(parseArgumentsLeniently('{"description":"leaked"}<parameter name="description">hello</parameter><parameter name="path">/x</parameter>'), undefined);
  assert.equal(parseArgumentsLeniently('{"value":1}<parameter name="value">2</parameter>'), undefined);
});

test("the leaked-parameter markup is matched by the exported pattern", () => {
  const matches = [...'<parameter name="a">one</parameter><antml:parameter name="b">two</antml:parameter><parameter name="c"></parameter>'.matchAll(leakedParameter)].map((match) => [match[1], match[2]]);
  assert.deepEqual(matches, [["a", "one"], ["b", "two"], ["c", ""]]);
  assert.deepEqual([..."plain text".matchAll(leakedParameter)], []);
});

test("every string token keeps its raw slice, including empty and escaped ones", () => {
  const stream = [...jsonTokens('hello "world" {x}[y]:, "" "a\\"b"', 0)] as Array<Record<string, unknown>>;
  assert.deepEqual(stream.filter((token) => token.kind === "string").map((token) => token.raw), ['"world"', '""', '"a\\"b"']);
});
