import assert from "node:assert/strict"
import { describe, it } from "node:test"

import { ReplayableAsyncIterable } from "../../source/packages/utils/replayable-async-iterable.ts"

async function collect<T>(source: AsyncIterable<T>): Promise<T[]> {
  const values: T[] = []
  for await (const value of source) values.push(value)
  return values
}

describe("replayable async iterable", () => {
  it("consumes a synchronous iterable once and replays it for readers that start after completion", async () => {
    let iterations = 0
    const source = {
      *[Symbol.iterator]() {
        iterations += 1
        yield "first"
        yield "second"
      },
    }
    const replayable = new ReplayableAsyncIterable(source)

    assert.deepEqual(await collect(replayable), ["first", "second"])
    assert.deepEqual(await collect(replayable), ["first", "second"])
    assert.equal(iterations, 1)
  })

  it("replays buffered values before sharing the same producer failure with every reader", async () => {
    const failure = new Error("producer stopped")
    let iterations = 0
    async function* source() {
      iterations += 1
      yield "buffered"
      throw failure
    }
    const replayable = new ReplayableAsyncIterable(source())
    const readFailure = async () => {
      const values: string[] = []
      await assert.rejects(
        () => collectInto(replayable, values),
        (error) => error === failure,
      )
      return values
    }

    const [early, late] = await Promise.all([readFailure(), readFailure()])
    assert.deepEqual(early, ["buffered"])
    assert.deepEqual(late, ["buffered"])
    assert.equal(iterations, 1)
  })

  it("normalizes a non-Error producer failure before exposing it to readers", async () => {
    async function* source() {
      throw "producer stopped"
    }
    const replayable = new ReplayableAsyncIterable(source())

    await assert.rejects(() => collect(replayable), (error) => error instanceof Error && error.message === "producer stopped")
  })
})

async function collectInto<T>(source: AsyncIterable<T>, values: T[]): Promise<void> {
  for await (const value of source) values.push(value)
}
