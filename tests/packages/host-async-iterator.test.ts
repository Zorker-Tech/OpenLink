import assert from "node:assert/strict";
import { describe, it } from "node:test";

import * as asyncIterator from "../../source/packages/utils/async-iterator.ts";
import { getFirstItem } from "../../source/packages/utils/async-iterator.ts";

const asyncSource = (values: readonly number[], log: string[], failureAt?: number): AsyncIterable<number> => ({
  [Symbol.asyncIterator]() {
    let index = 0;
    return {
      async next() {
        log.push(`next:${index}`);
        if (failureAt === index) throw new Error(`boom at ${index}`);
        if (index >= values.length) return { done: true, value: undefined };
        const value = values[index]!;
        index += 1;
        return { done: false, value };
      },
    };
  },
});

describe("peeking at an async iterable", () => {
  it("is undefined for an empty iterable, having asked it once", async () => {
    assert.deepEqual(Object.keys(asyncIterator), ["getFirstItem"]);
    const log: string[] = [];
    assert.equal(await getFirstItem(asyncSource([], log)), undefined);
    assert.deepEqual(log, ["next:0"]);
  });

  it("hands back the first item and the rest, without pulling ahead", async () => {
    const log: string[] = [];
    const peeked = await getFirstItem(asyncSource([1, 2, 3], log));
    assert.equal(peeked?.firstItem, 1);
    assert.deepEqual(log, ["next:0"], "the peek reads exactly one item");
    assert.notEqual(peeked, undefined);
    const rest: number[] = [];
    for await (const item of peeked!.rest) rest.push(item);
    assert.deepEqual(rest, [2, 3]);
    assert.deepEqual(log, ["next:0", "next:1", "next:2", "next:3"]);
  });

  it("shares one underlying iterator between two consumers of the rest", async () => {
    const picked = await getFirstItem(asyncSource([1, 2, 3, 4], []));
    const first: number[] = [];
    for await (const item of picked!.rest) {
      first.push(item);
      break;
    }
    const second: number[] = [];
    for await (const item of picked!.rest) second.push(item);
    assert.deepEqual(first, [2]);
    assert.deepEqual(second, [3, 4]);
  });

  it("surfaces a source failure the same way from the peek and from the rest", async () => {
    await assert.rejects(() => getFirstItem(asyncSource([1], [], 0)), { message: "boom at 0" });
    const peeked = await getFirstItem(asyncSource([1, 2], [], 2));
    await assert.rejects(async () => {
      for await (const _item of peeked!.rest) void _item;
    }, { message: "boom at 2" });
  });
});