import assert from "node:assert/strict"
import { mkdtemp, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { after, test } from "node:test"

import { getFormatForFile, LineEnding, readText } from "../../source/packages/utils/text-encoding.ts"

const root = await mkdtemp(join(tmpdir(), "slate-text-encoding-contract-"))
after(async () => await rm(root, { recursive: true, force: true }))

function wideAscii(text: string, endian: "le" | "be", unitBytes: 2 | 4): Buffer {
  const bytes = Buffer.alloc(text.length * unitBytes)
  for (let index = 0; index < text.length; index += 1) {
    const code = text.charCodeAt(index)
    if (unitBytes === 2) {
      if (endian === "le") bytes.writeUInt16LE(code, index * unitBytes)
      else bytes.writeUInt16BE(code, index * unitBytes)
    } else if (endian === "le") bytes.writeUInt32LE(code, index * unitBytes)
    else bytes.writeUInt32BE(code, index * unitBytes)
  }
  return bytes
}

test("byte-order marks identify wide text before the binary heuristic", async () => {
  const cases: Array<{ name: string; bytes: Buffer; encoding: string; text: string }> = [
    { name: "utf16le.txt", bytes: Buffer.concat([Buffer.from([0xff, 0xfe]), wideAscii("wide text", "le", 2)]), encoding: "UTF-16LE", text: "wide text" },
    { name: "utf16be.txt", bytes: Buffer.concat([Buffer.from([0xfe, 0xff]), wideAscii("wide text", "be", 2)]), encoding: "UTF-16BE", text: "wide text" },
    { name: "utf32le.txt", bytes: Buffer.concat([Buffer.from([0xff, 0xfe, 0, 0]), wideAscii("wide text", "le", 4)]), encoding: "UTF-32LE", text: "wide text" },
    { name: "utf32be.txt", bytes: Buffer.concat([Buffer.from([0, 0, 0xfe, 0xff]), wideAscii("wide text", "be", 4)]), encoding: "UTF-32BE", text: "wide text" },
  ]

  for (const item of cases) {
    const path = join(root, item.name)
    await writeFile(path, item.bytes)
    const format = await getFormatForFile(path)
    assert.equal(format.encoding, item.encoding)
    assert.equal(format.isBinaryFile, false)
    assert.equal(await readText(path), item.text)
  }
})

test("image signatures are reported separately from generic binary files", async () => {
  const images = [
    ["png", Buffer.from([137, 80, 78, 71, 13, 10, 26, 10, 0])],
    ["jpeg", Buffer.from([255, 216, 255, 0])],
    ["gif", Buffer.from([71, 73, 70, 56, 57, 97, 0])],
    ["webp", Buffer.from("RIFF0000WEBP\0\0\0\0", "ascii")],
  ] as const
  for (const [name, bytes] of images) {
    const path = join(root, `${name}.bin`)
    await writeFile(path, bytes)
    assert.deepEqual(
      [((await getFormatForFile(path)).isBinaryFile), (await getFormatForFile(path)).isImageFile],
      [true, true],
    )
  }

  const unknown = join(root, "unknown.bin")
  await writeFile(unknown, Buffer.from([0, 1, 2, 3, 4, 5, 6, 7]))
  assert.deepEqual([ (await getFormatForFile(unknown)).isBinaryFile, (await getFormatForFile(unknown)).isImageFile ], [true, false])
})

test("CRLF classification changes at the configured five-percent boundary", async () => {
  const atBoundary = join(root, "five-percent.txt")
  const belowBoundary = join(root, "below-five-percent.txt")
  const crlfAtFivePercent = `a\r\n${"b\n".repeat(19)}`
  const crlfBelowFivePercent = `a\r\n${"b\n".repeat(20)}`
  await writeFile(atBoundary, crlfAtFivePercent)
  await writeFile(belowBoundary, crlfBelowFivePercent)

  assert.equal((await getFormatForFile(atBoundary)).lineEnding, LineEnding.CRLF)
  assert.equal((await readText(atBoundary)).includes("\r\n"), false)
  assert.equal((await getFormatForFile(belowBoundary)).lineEnding, LineEnding.LF)
  assert.equal(await readText(belowBoundary), crlfBelowFivePercent)
})
