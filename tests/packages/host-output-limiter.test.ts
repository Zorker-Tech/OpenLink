/**
 * Moving a command's output without drowning it: what is joined, when it is delivered, and what a failure costs.
 */

import assert from "node:assert/strict";
import { PassThrough, Readable } from "node:stream";
import { describe, it } from "node:test";

import { attachShellOutputStreams } from "../../source/packages/shell-exec/output-limiter.ts";

/** The sink the platform reads through, recording what it was handed. */
function sink(options: { fail?: boolean } = {}) {
  const writes: Array<{ name: string; text: string }> = [];
  return {
    writes,
    writable: {
      async write(chunk: { type: string; data: Buffer }) {
        writes.push({ name: chunk.type, text: chunk.data.toString() });
        if (options.fail === true) throw new Error("the sink refused");
      },
    },
  };
}

/** A stream that emits what the test says, and then ends (or fails). */
function stream(chunks: readonly string[], options: { fail?: boolean } = {}) {
  const source = Readable.from(chunks.map((chunk) => Buffer.from(chunk)));
  if (options.fail === true) {
    const original = Readable.prototype[Symbol.asyncIterator];
    (source as unknown as Record<symbol, unknown>)[Symbol.asyncIterator] = async function* failAfterChunks(this: Readable) {
      for await (const chunk of original.call(this)) yield chunk;
      throw new Error("the stream broke");
    };
  }
  return source as unknown as AsyncIterable<Buffer> & { on(event: "data", listener: (data: Buffer) => void): unknown };
}

const tick = (ms = 20) => new Promise((resolve) => setTimeout(resolve, ms));

describe("without buffering", () => {
  it("writes each chunk as it arrives, in order, and a refused write costs nothing", async () => {
    const world = sink({ fail: true });
    const attached = attachShellOutputStreams({ stdout: stream(["a", "b"]), stderr: stream(["c"]), writable: world.writable, bufferOutputEvents: false });
    assert.deepEqual(await attached.waitForOutput(), undefined);
    assert.deepEqual(await attached.flush(), undefined);
    await tick(5);
    assert.deepEqual(world.writes.map((write) => `${write.name}:${write.text}`).sort(), ["stderr:c", "stdout:a", "stdout:b"]);
  });
});

describe("with buffering", () => {
  it("joins chunks of the same stream into one write, and keeps the order across streams", async () => {
    const world = sink();
    const attached = attachShellOutputStreams({
      stdout: stream(["one ", "two"]),
      stderr: stream(["err"]),
      writable: world.writable,
      bufferOutputEvents: true,
      outputLimiterOptions: { flushIntervalMs: 5, maxBufferedBytes: 1_000 },
    });
    await attached.waitForOutput();
    await attached.flush();
    // Nothing is lost and nothing is reordered: each stream's writes spell it out in full, and both streams appear.
    const textOf = (name: string) => world.writes.filter((write) => write.name === name).map((write) => write.text).join("");
    assert.deepEqual([textOf("stdout"), textOf("stderr")], ["one two", "err"]);
    assert.deepEqual([...new Set(world.writes.map((write) => write.name))].sort(), ["stderr", "stdout"]);
  });

  it("delivers on its own timer, without anyone asking", async () => {
    const world = sink();
    const attached = attachShellOutputStreams({ stdout: stream(["late"]), writable: world.writable, bufferOutputEvents: true, outputLimiterOptions: { flushIntervalMs: 5, maxBufferedBytes: 1_000 } });
    await tick(30);
    assert.deepEqual(world.writes.map((write) => write.text), ["late"]);
    await attached.waitForOutput();
  });

  it("delivers at once when the buffer reaches its bound", async () => {
    const world = sink();
    const attached = attachShellOutputStreams({
      stdout: stream(["aaaa", "bbbb", "cccc"]),
      writable: world.writable,
      bufferOutputEvents: true,
      // A long timer makes the early delivery the only thing that can have written before it fires.
      outputLimiterOptions: { flushIntervalMs: 10_000, maxBufferedBytes: 8 },
    });
    await tick(20);
    // The bound (8 bytes) is reached by the second chunk, so that much is delivered long before the timer would fire.
    assert.deepEqual(world.writes.map((write) => write.text), ["aaaabbbb"]);
    await attached.waitForOutput();
    await attached.flush();
    assert.equal(world.writes.map((write) => write.text).join(""), "aaaabbbbcccc");
  });

  it("keeps a delivery from overtaking the one in flight, and delivers what arrived meanwhile after it", async () => {
    const world = sink();
    // A sink that takes its time, so a second delivery has something to wait for and a second chunk somewhere to arrive.
    const slow = {
      async write(chunk: { type: string; data: Buffer }) {
        world.writes.push({ name: chunk.type, text: chunk.data.toString() });
        await tick(30);
      },
    };
    const source = new PassThrough();
    const attached = attachShellOutputStreams({ stdout: source as never, writable: slow, bufferOutputEvents: true, outputLimiterOptions: { flushIntervalMs: 5, maxBufferedBytes: 1_000 } });
    source.write("first");
    await tick(10);
    assert.deepEqual(world.writes.map((write) => write.text), ["first"], "the timer delivered the first chunk");
    // The second chunk arrives while the first write is still in flight.
    source.write("second");
    await tick(2);
    const second = attached.flush();
    await second;
    // The flush waited for the write in flight and then delivered what arrived: not returned leaving it behind.
    assert.deepEqual(world.writes.map((write) => write.text), ["first", "second"]);
    source.end();
    await attached.waitForOutput();
  });

  it("swallows a refused delivery: the command already ran", async () => {
    const world = sink({ fail: true });
    const attached = attachShellOutputStreams({ stdout: stream(["lost"]), writable: world.writable, bufferOutputEvents: true, outputLimiterOptions: { flushIntervalMs: 5 } });
    await attached.waitForOutput();
    await attached.flush();
    assert.deepEqual(world.writes.map((write) => write.text), ["lost"]);
  });

  it("reports a broken stream to whoever waits, and never to the command", async () => {
    const world = sink();
    const attached = attachShellOutputStreams({ stdout: stream(["x"], { fail: true }), writable: world.writable, bufferOutputEvents: true, outputLimiterOptions: { flushIntervalMs: 5 } });
    await assert.rejects(() => attached.waitForOutput(), /the stream broke/);
    await attached.flush();
  });

  it("takes a command with no streams, and drops empty chunks", async () => {
    const world = sink();
    const attached = attachShellOutputStreams({ writable: world.writable, bufferOutputEvents: true, outputLimiterOptions: { flushIntervalMs: 5 } });
    await attached.waitForOutput();
    await attached.flush();
    assert.deepEqual(world.writes, []);
    const empty = sink();
    const withEmpty = attachShellOutputStreams({ stdout: stream(["", "y", ""]), stderr: null, writable: empty.writable, bufferOutputEvents: true, outputLimiterOptions: { flushIntervalMs: 5 } });
    await withEmpty.waitForOutput();
    await withEmpty.flush();
    assert.deepEqual(empty.writes.map((write) => write.text), ["y"]);
  });
});
