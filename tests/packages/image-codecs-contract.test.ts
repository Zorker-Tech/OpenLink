import assert from "node:assert/strict"
import { describe, it } from "node:test"

import { getImageCodecs } from "../../source/packages/utils/image-codecs.ts"

describe("image codec loader", () => {
  it("shares lazy initialization and returns a reusable PNG codec set", async () => {
    const firstLoad = getImageCodecs()
    const concurrentLoad = getImageCodecs()
    assert.equal(firstLoad, concurrentLoad)

    const [first, second] = await Promise.all([firstLoad, concurrentLoad])
    assert.equal(first, second)
    const encoded = await first.fromBitmap({ data: Buffer.alloc(4), width: 1, height: 1 }).getBuffer("image/png")
    const decoded = await first.read(encoded)
    assert.deepEqual([decoded.width, decoded.height], [1, 1])
  })
})
