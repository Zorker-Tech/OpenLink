import assert from "node:assert/strict"
import test from "node:test"
import { mkdtemp, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"

import { loadSelectedImageInputs } from "../../source/host/selected-image-inputs.ts"

test("image inputs keep request order, infer known types, and skip files that cannot be read", async () => {
  const root = await mkdtemp(join(tmpdir(), "slate-selected-images-"))
  const first = join(root, "first.png")
  const second = join(root, "second.unknown")
  const firstBytes = new Uint8Array([1, 2, 3])
  const secondBytes = new Uint8Array([9, 8])

  try {
    await writeFile(first, firstBytes)
    await writeFile(second, secondBytes)

    const loaded = await loadSelectedImageInputs([second, join(root, "missing.png"), first])
    assert.deepEqual(loaded.map(image => image.path), [second, first])
    assert.deepEqual(loaded.map(image => image.mimeType), [undefined, "image/png"])
    assert.deepEqual([...loaded[0]!.data], [...secondBytes])
    assert.equal(Buffer.isBuffer(loaded[0]!.data), false)
    assert.deepEqual(await loadSelectedImageInputs([]), [])
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})
