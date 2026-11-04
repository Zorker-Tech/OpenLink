import assert from "node:assert/strict"
import { createHash } from "node:crypto"
import { mkdtemp, readFile, rm, stat } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { fileURLToPath, pathToFileURL } from "node:url"
import test from "node:test"
import { materializeInlineImages, type InlineImage } from "../../source/host/transcript/inline-image-materialization.ts"

async function withSession(run: (root: string) => Promise<void>): Promise<void> {
  const root = await mkdtemp(join(tmpdir(), "slate-inline-images-"))
  try {
    await run(root)
  } finally {
    await rm(root, { recursive: true, force: true })
  }
}

test("no inline images means no attachment folder is created", async () => {
  await withSession(async root => {
    assert.deepEqual(await materializeInlineImages({ dbPath: join(root, "session.sqlite") }, []), [])
    await assert.rejects(stat(join(root, "xuser-attachments")), { code: "ENOENT" })
  })
})

test("image bytes are stored by digest and returned as local file URLs", async () => {
  await withSession(async root => {
    const bytes = Buffer.from("image contents")
    const digest = createHash("sha256").update(bytes).digest("hex")
    const result = await materializeInlineImages({ dbPath: join(root, "session.sqlite") }, [
      { base64: bytes.toString("base64"), mediaType: "IMAGE/WEBP", alt: "chart" },
    ])
    const expectedPath = join(root, "xuser-attachments", `${digest}.webp`)

    assert.deepEqual(result, [{ url: pathToFileURL(expectedPath).toString(), alt: "chart" }])
    assert.equal(fileURLToPath(result[0]!.url), expectedPath)
    assert.deepEqual(await readFile(expectedPath), bytes)
  })
})

test("only the first four inputs are considered, and one unusable image does not stop later ones", async () => {
  await withSession(async root => {
    const skipped = { base64: "", mediaType: "image/png" }
    const badShape = { base64: null, mediaType: "image/png" } as unknown as InlineImage
    const acceptedBytes = Buffer.from("fourth image")
    const laterBytes = Buffer.from("fifth image")
    const result = await materializeInlineImages({ dbPath: join(root, "session.sqlite") }, [
      skipped,
      badShape,
      skipped,
      { base64: acceptedBytes.toString("base64"), mediaType: "image/unknown", alt: "" },
      { base64: laterBytes.toString("base64"), mediaType: "image/png" },
    ])
    const acceptedPath = fileURLToPath(result[0]!.url)

    assert.equal(result.length, 1)
    assert.equal(acceptedPath, join(root, "xuser-attachments", `${createHash("sha256").update(acceptedBytes).digest("hex")}.png`))
    assert.deepEqual(result[0], { url: pathToFileURL(acceptedPath).toString(), alt: "" })
    await assert.rejects(stat(join(root, "xuser-attachments", `${createHash("sha256").update(laterBytes).digest("hex")}.png`)), { code: "ENOENT" })
    assert.deepEqual(await readFile(acceptedPath), acceptedBytes)
  })
})
