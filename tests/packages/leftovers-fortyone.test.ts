/**
 * The registry of everything the platform can be told remotely: the flags, the experiments and the
 * configurations it reads, and the parsers their values go through.
 */

import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { DYNAMIC_CONFIGS, DYNAMIC_CONFIGS_KEYS, EXPERIMENT_NAMES, EXPERIMENTS, FEATURE_FLAGS, FLAGS, LAYERS, parseBoolean, parseEnum, parseNumber, parseNumberArray, parseString, parseStringArray } from "../../source/shared/node/experiments/experiment-config.gen.ts";

describe("the registry of remote settings", () => {
  it("lists the flags, the experiments and the configurations with what each of them is", () => {
    assert.equal(Object.keys(FLAGS).length > 500, true);
    assert.equal(Object.keys(EXPERIMENTS).length > 100, true);
    assert.equal(Object.keys(DYNAMIC_CONFIGS).length > 100, true);
    assert.equal(Object.keys(DYNAMIC_CONFIGS_KEYS).length > 100, true);
    assert.equal(Object.keys(EXPERIMENT_NAMES).length > 100, true);
    assert.equal(Array.isArray(FEATURE_FLAGS), true);
    assert.equal(FEATURE_FLAGS.length > 500, true);
    assert.equal(typeof LAYERS, "object");
    const sample = FLAGS.agent_goal_continuation;
    assert.equal(typeof sample, "object");
    assert.equal(typeof (sample as { client?: unknown }).client, "boolean");
    assert.equal(typeof (sample as { default?: unknown }).default, "boolean");
  });

  it("reads a value with the parser its entry names", () => {
    assert.equal(parseBoolean(true), true);
    assert.throws(() => parseBoolean("yes"));
    assert.equal(parseNumber(3), 3);
    assert.throws(() => parseNumber("three"));
    assert.equal(parseString("a"), "a");
    assert.throws(() => parseString(1));
    assert.deepEqual(parseStringArray(["a", "b"]), ["a", "b"]);
    assert.deepEqual(parseNumberArray([1, 2]), [1, 2]);
    const parser = parseEnum(["a", "b"]);
    assert.equal(parser("a"), "a");
    assert.deepEqual(parser.enumValues, ["a", "b"]);
    assert.throws(() => parser("c"));
  });
});
