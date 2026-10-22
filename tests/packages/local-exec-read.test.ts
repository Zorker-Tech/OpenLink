import { test } from "node:test"
import assert from "node:assert/strict"
import fs from "node:fs"
import os from "node:os"
import path from "node:path"

import { LocalReadExecutor } from "../../source/packages/local-exec/read.ts"
import { createContext } from "../../source/packages/context/context.ts"
import type { ReadResult, ReadSuccess } from "../../source/packages/proto/generated/agent/v1/read_exec_pb.ts"

// ---------------------------------------------------------------------------------------------
// harness
// ---------------------------------------------------------------------------------------------

const allowAll = { shouldBlockRead: () => false }
const ctx = createContext()

function withWorkspace(run: (workspace: string) => Promise<void>) {
  const workspace = fs.mkdtempSync(path.join(os.tmpdir(), "slate-read-"))
  return run(workspace).finally(() => fs.rmSync(workspace, { recursive: true, force: true }))
}

const write = (workspace: string, relativePath: string, content: string | Buffer) => {
  const target = path.join(workspace, relativePath)
  fs.mkdirSync(path.dirname(target), { recursive: true })
  fs.writeFileSync(target, content)
}

const terminalFile = (workspace: string, name: string, content: string | Buffer) => {
  write(workspace, path.join(".slate", "projects", "workspace-1", "terminals", name), content)
  return path.join(".slate", "projects", "workspace-1", "terminals", name)
}

const agentToolFile = (workspace: string, name: string, content: string | Buffer) => {
  write(workspace, path.join(".slate", "projects", "workspace-1", "agent-tools", name), content)
  return path.join(".slate", "projects", "workspace-1", "agent-tools", name)
}

const successOf = (result: ReadResult): ReadSuccess => {
  assert.equal(result.result.case, "success")
  if (result.result.case !== "success") throw new Error("not a success")
  return result.result.value
}

const contentOf = (result: ReadResult): string => {
  const success = successOf(result)
  if (success.output.case !== "content") throw new Error("not content")
  return success.output.value
}

const streaming = { useStreamingRead: async () => true }

// ---------------------------------------------------------------------------------------------
// reading text, and the ranges over it
// ---------------------------------------------------------------------------------------------

test("a text read applies the caller's range over the whole file", async () => {
  await withWorkspace(async (workspace) => {
    fs.writeFileSync(path.join(workspace, "notes.txt"), "one\ntwo\nthree\n")
    const executor = new LocalReadExecutor(allowAll, workspace)
    const whole = contentOf(await executor.execute(ctx, { path: "notes.txt" }))
    assert.equal(whole, "one\ntwo\nthree\n")
    assert.equal(successOf(await executor.execute(ctx, { path: "notes.txt" })).totalLines, 4)

    assert.equal(contentOf(await executor.execute(ctx, { path: "notes.txt", offset: 2 })), "two\nthree\n")
    assert.equal(successOf(await executor.execute(ctx, { path: "notes.txt", offset: 2, limit: 2 })).rangeApplied, true)
    assert.equal(contentOf(await executor.execute(ctx, { path: "notes.txt", offset: 2, limit: 2 })), "two\nthree")
    assert.equal(contentOf(await executor.execute(ctx, { path: "notes.txt", limit: 2 })), "one\ntwo")
    assert.equal(contentOf(await executor.execute(ctx, { path: "notes.txt", offset: -2 })), "three\n")
    assert.equal(contentOf(await executor.execute(ctx, { path: "notes.txt", offset: -2, limit: 1 })), "three")

    const beyond = await executor.execute(ctx, { path: "notes.txt", offset: 50 })
    assert.equal(contentOf(beyond), whole, "a range past the end keeps the whole file")
    assert.equal(successOf(beyond).rangeApplied, false)
    const atEnd = await executor.execute(ctx, { path: "notes.txt", offset: 5 })
    assert.equal(contentOf(atEnd), whole, "an offset exactly at the last line index is past the range")
    assert.equal(successOf(atEnd).rangeApplied, false)
    assert.equal(contentOf(await executor.execute(ctx, { path: "notes.txt", limit: 0 })), "", "a zero limit keeps nothing");
  })
})

test("an empty file stays empty whatever range is asked for", async () => {
  await withWorkspace(async (workspace) => {
    fs.writeFileSync(path.join(workspace, "empty.txt"), "")
    const executor = new LocalReadExecutor(allowAll, workspace)
    const ranged = await executor.execute(ctx, { path: "empty.txt", offset: 1, limit: 2 })
    assert.equal(contentOf(ranged), "")
    assert.equal(successOf(ranged).rangeApplied, false)
    assert.equal(successOf(await executor.execute(ctx, { path: "empty.txt" })).totalLines, 1)
  })
})

test("a text file is handed back as data when it is an image, a PDF or a video", async () => {
  await withWorkspace(async (workspace) => {
    const png = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==", "base64")
    fs.writeFileSync(path.join(workspace, "tiny.png"), png)
    fs.writeFileSync(path.join(workspace, "data.pdf"), "%PDF-1.4\nnot really a pdf\n")
    fs.writeFileSync(path.join(workspace, "clip.mp4"), Buffer.from([0, 0, 0, 24, 0x66, 0x74, 0x79, 0x70]))
    fs.writeFileSync(path.join(workspace, "broken.png"), Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 0]))
    const executor = new LocalReadExecutor(allowAll, workspace)

    const image = successOf(await executor.execute(ctx, { path: "tiny.png" }))
    assert.equal(image.output.case, "data")
    assert.equal(Buffer.from(image.output.value as Uint8Array).subarray(0, 4).toString("hex"), "89504e47")
    assert.equal(image.totalLines, 0)
    assert.equal(image.truncated, false)
    assert.equal(image.fileSize, BigInt(png.length))

    const pdf = successOf(await executor.execute(ctx, { path: "data.pdf" }))
    assert.equal(pdf.output.case, "data", "a PDF is data, not decoded text")
    const video = successOf(await executor.execute(ctx, { path: "clip.mp4" }))
    assert.equal(video.output.case, "data", "a video is data, not decoded text")

    const broken = await executor.execute(ctx, { path: "broken.png" })
    assert.equal(broken.result.case, "error", "an image that cannot be decoded is an answer, not a hang")
  })
})

test("a binary format the model cannot read is refused with the format named", async () => {
  await withWorkspace(async (workspace) => {
    fs.writeFileSync(path.join(workspace, "blob.bin"), Buffer.from([0x50, 0x4b, 0x03, 0x04, 0, 0, 0, 0]))
    fs.writeFileSync(path.join(workspace, "no-extension"), Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))
    const executor = new LocalReadExecutor(allowAll, workspace)
    const typed = await executor.execute(ctx, { path: "blob.bin" })
    assert.equal(typed.result.case, "invalidFile")
    assert.match(String((typed.result.value as { reason?: string }).reason), /Binary files of type \.bin are not supported/)
    const untyped = await executor.execute(ctx, { path: "no-extension" })
    assert.equal(untyped.result.case, "error", "an extension-less file the text decoder cannot read is an error, not mojibake")
  })
})

test("what cannot be read is reported as its own answer", async () => {
  await withWorkspace(async (workspace) => {
    fs.mkdirSync(path.join(workspace, "a-directory"))
    const executor = new LocalReadExecutor(allowAll, workspace)
    assert.equal((await executor.execute(ctx, { path: "not-here.txt" })).result.case, "fileNotFound")
    const directory = await executor.execute(ctx, { path: "a-directory" })
    assert.equal(directory.result.case, "invalidFile")
    assert.match(String((directory.result.value as { reason?: string }).reason), /is a directory, not a file/)
  })
})

test("a path the user may not read is refused before anything is read", async () => {
  await withWorkspace(async (workspace) => {
    fs.writeFileSync(path.join(workspace, "secret.txt"), "hidden")
    const executor = new LocalReadExecutor({ shouldBlockRead: candidate => candidate.endsWith("secret.txt") }, workspace)
    const result = await executor.execute(ctx, { path: "secret.txt" })
    assert.equal(result.result.case, "permissionDenied")
    assert.equal((result.result.value as { path?: string }).path, path.join(workspace, "secret.txt"))
    await assert.rejects(async () => {
      const failing = new LocalReadExecutor({ shouldBlockRead: () => { throw new Error("permission service failed"); } }, workspace)
      await failing.execute(ctx, { path: "secret.txt" })
    }, { message: "permission service failed" }, "a permission service that throws is not turned into a read answer")
  })
})

// ---------------------------------------------------------------------------------------------
// the streaming read
// ---------------------------------------------------------------------------------------------

test("the streaming read returns the same text, and applies the same ranges", async () => {
  await withWorkspace(async (workspace) => {
    fs.writeFileSync(path.join(workspace, "notes.txt"), "one\ntwo\nthree\n")
    const executor = new LocalReadExecutor(allowAll, workspace, streaming)
    assert.equal(contentOf(await executor.execute(ctx, { path: "notes.txt" })), "one\ntwo\nthree\n")
    assert.equal(successOf(await executor.execute(ctx, { path: "notes.txt" })).totalLines, 4)
    assert.equal(contentOf(await executor.execute(ctx, { path: "notes.txt", offset: 2, limit: 2 })), "two\nthree")
    assert.equal(contentOf(await executor.execute(ctx, { path: "notes.txt", offset: -2 })), "three\n")
    assert.equal(contentOf(await executor.execute(ctx, { path: "notes.txt", offset: -2, limit: 1 })), "three")
    const beyond = await executor.execute(ctx, { path: "notes.txt", offset: 50 })
    assert.equal(contentOf(beyond), "one\ntwo\nthree\n")
    assert.equal(successOf(beyond).rangeApplied, false)
    assert.equal(contentOf(await executor.execute(ctx, { path: "notes.txt", limit: 0 })), "")
  })
})

test("the streaming read drops a byte-order mark and falls back to latin1 for bytes that are not UTF-8", async () => {
  await withWorkspace(async (workspace) => {
    fs.writeFileSync(path.join(workspace, "bom.txt"), Buffer.from([0xef, 0xbb, 0xbf, 0x68, 0x69, 0x0a]))
    fs.writeFileSync(path.join(workspace, "latin1.txt"), Buffer.from([0x63, 0x61, 0x66, 0xe9, 0x0a]))
    const executor = new LocalReadExecutor(allowAll, workspace, streaming)
    assert.equal(contentOf(await executor.execute(ctx, { path: "bom.txt" })), "hi\n", "the mark is metadata, not content")
    assert.equal(contentOf(await executor.execute(ctx, { path: "latin1.txt" })), "café\n", "invalid UTF-8 is read as latin1 rather than failed")
    assert.equal(contentOf(await executor.execute(ctx, { path: "latin1.txt", encodingHint: "utf-8" })), "café\n", "a UTF-8 hint over bytes that are not UTF-8 falls back to latin1")
  })
})

test("the streaming read decodes an encoding hint the caller names", async () => {
  await withWorkspace(async (workspace) => {
    fs.writeFileSync(path.join(workspace, "utf16le.txt"), Buffer.from("one\ntwo\n", "utf16le"))
    fs.writeFileSync(path.join(workspace, "utf16be.txt"), Buffer.concat([Buffer.from([0xfe, 0xff]), Buffer.from("one\ntwo\n", "utf16le").swap16()]))
    fs.writeFileSync(path.join(workspace, "notes.txt"), "one\ntwo\n")
    const executor = new LocalReadExecutor(allowAll, workspace, streaming)
    assert.equal(contentOf(await executor.execute(ctx, { path: "utf16le.txt", encodingHint: "utf-16le" })), "one\ntwo\n")
    assert.equal(contentOf(await executor.execute(ctx, { path: "utf16be.txt", encodingHint: "utf-16be" })), "one\ntwo\n")
    assert.equal(contentOf(await executor.execute(ctx, { path: "notes.txt", encodingHint: "utf-8" })), "one\ntwo\n")
  })
})

test("the streaming read normalizes CRLF only when the file mostly uses it", async () => {
  await withWorkspace(async (workspace) => {
    fs.writeFileSync(path.join(workspace, "crlf-heavy.txt"), "one\r\ntwo\r\nthree\r\nfour\r\n")
    fs.writeFileSync(path.join(workspace, "crlf-rare.txt"), Array.from({ length: 30 }, (_, index) => index === 25 ? "twenty-six\r" : "line " + index).join("\n"))
    const executor = new LocalReadExecutor(allowAll, workspace, streaming)
    assert.equal(contentOf(await executor.execute(ctx, { path: "crlf-heavy.txt" })), "one\ntwo\nthree\nfour\n", "a mostly-CRLF file is normalized")
    const rare = contentOf(await executor.execute(ctx, { path: "crlf-rare.txt" }))
    assert.equal(rare.includes("\r"), true, "one CRLF in thirty lines is kept as it was")
  })
})

test("a streaming read keeps the text within its budget and says it was cut", async () => {
  await withWorkspace(async (workspace) => {
    fs.writeFileSync(path.join(workspace, "big.txt"), "line\n".repeat(1_800_000))
    const executor = new LocalReadExecutor(allowAll, workspace, streaming)
    const result = successOf(await executor.execute(ctx, { path: "big.txt" }))
    assert.equal(result.truncated, true)
    assert.equal(String(result.output.value).length <= 8 * 1024 * 1024, true)
    assert.equal(result.totalLines, 1_800_001)
  })
})

// ---------------------------------------------------------------------------------------------
// terminal records and agent-tool output
// ---------------------------------------------------------------------------------------------

test("a terminal's output is decoded as records, with its footer kept and its encoding detected", async () => {
  await withWorkspace(async (workspace) => {
    const plain = terminalFile(workspace, "1.txt", "the command's output\nsecond line\n")
    const withFooter = terminalFile(workspace, "2.txt", "body line\n---\nexit_code: 0\nended_at: 2024-01-01T00:00:00Z\n---\n")
    const withFrontmatter = terminalFile(workspace, "3.txt", "---\nterminal: meta\n---\nbody line\n")
    const utf16le = terminalFile(workspace, "4.txt", Buffer.concat([Buffer.from("---\nterminal: meta\n---\n"), Buffer.from([0xff, 0xfe]), Buffer.from("utf-16le body\n", "utf16le")]))
    const utf16be = terminalFile(workspace, "5.txt", Buffer.concat([Buffer.from("---\nterminal: meta\n---\n"), Buffer.from([0xfe, 0xff]), Buffer.from("utf-16be body\n", "utf16le").swap16()]))
    const heuristic = terminalFile(workspace, "6.txt", Buffer.from("utf-16 heuristic without bom 1234567890\n", "utf16le"))
    const crlf = terminalFile(workspace, "7.txt", "one\r\ntwo\r\nthree\r\n")
    const executor = new LocalReadExecutor(allowAll, workspace)

    assert.equal(contentOf(await executor.execute(ctx, { path: plain })), "the command's output\nsecond line\n")
    const footer = contentOf(await executor.execute(ctx, { path: withFooter }))
    assert.equal(footer.includes("exit_code: 0"), true, "a valid footer is part of the records")
    assert.equal(footer.endsWith("---\n"), true)
    const frontmatter = contentOf(await executor.execute(ctx, { path: withFrontmatter }))
    assert.equal(frontmatter.startsWith("---\nterminal: meta\n---\n"), true, "frontmatter is kept as records")
    assert.equal(contentOf(await executor.execute(ctx, { path: utf16le })).includes("utf-16le body"), true)
    assert.equal(contentOf(await executor.execute(ctx, { path: utf16be })).includes("utf-16be body"), true)
    assert.equal(contentOf(await executor.execute(ctx, { path: heuristic })).includes("utf-16 heuristic without bom"), true, "paired zero bytes name the encoding when there is no mark")
    assert.equal(contentOf(await executor.execute(ctx, { path: crlf })).includes("\r\n"), false, "a terminal's CRLF pairs are normalized")
    assert.equal(contentOf(await executor.execute(ctx, { path: withFooter, offset: 1, limit: 1 })), "body line")
  })
})

test("an agent-tool output is read as records unless its bytes name a binary format", async () => {
  await withWorkspace(async (workspace) => {
    const text = agentToolFile(workspace, "1.txt", "agent tool output\nsecond line\n")
    const binary = agentToolFile(workspace, "2.txt", Buffer.from([0x50, 0x4b, 0x03, 0x04, 0, 0, 0, 0]))
    const executor = new LocalReadExecutor(allowAll, workspace)
    assert.equal(contentOf(await executor.execute(ctx, { path: text })), "agent tool output\nsecond line\n")
    const refused = await executor.execute(ctx, { path: binary })
    assert.equal(refused.result.case, "invalidFile")
    assert.match(String((refused.result.value as { reason?: string }).reason), /Binary files of type \.txt are not supported/)
  })
})
