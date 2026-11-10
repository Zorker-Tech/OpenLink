import { test } from "node:test"
import { createContext } from "../../source/packages/context/context.ts"
import assert from "node:assert/strict"
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"

import {
  LegacyFileTranscriptMirror,
  countTranscriptMessageLines,
  formatSingleMessageJsonl,
} from "../../source/host/transcript/mirror/legacy-transcript-mirror.ts"

const withTempDir = (run: (dir: string) => Promise<void>): Promise<void> => {
  const dir = mkdtempSync(join(tmpdir(), "legacy-mirror-test-"))
  return run(dir).finally(() => rmSync(dir, { recursive: true, force: true }))
}
const encode = (value: unknown): Uint8Array => new TextEncoder().encode(JSON.stringify(value))
const makeStore = (blobs: Map<Uint8Array, Uint8Array>) => ({
  async getBlob(_ctx: unknown, id: Uint8Array): Promise<Uint8Array | undefined> {
    for (const [key, value] of blobs) {
      if (key.length === id.length && key.every((byte, index) => byte === id[index])) return value
    }
    return undefined
  },
})
const id = (value: number): Uint8Array => new Uint8Array([value])

test("only message lines count", () => {
  assert.equal(countTranscriptMessageLines(""), 0)
  assert.equal(countTranscriptMessageLines("   \n\n"), 0)
  assert.equal(countTranscriptMessageLines(JSON.stringify({ type: "metadata" })), 0)
  assert.equal(countTranscriptMessageLines(JSON.stringify({ type: "turn_ended" })), 0)
  assert.equal(countTranscriptMessageLines(JSON.stringify({ role: "user" })), 1)
  assert.equal(countTranscriptMessageLines("not json"), 1)
  assert.equal(countTranscriptMessageLines([JSON.stringify({ role: "user" }), JSON.stringify({ type: "metadata" }), JSON.stringify({ role: "assistant" })].join("\n")), 2)
})

test("a message becomes a transcript line, and the hidden parts do not", () => {
  assert.equal(formatSingleMessageJsonl({ role: "system", content: "sys" }), undefined)
  assert.equal(formatSingleMessageJsonl({ role: "assistant", providerOptions: { slate: { isSummary: true } }, content: "summary" }), undefined)
  assert.deepEqual(JSON.parse(formatSingleMessageJsonl({ role: "user", content: "hello" }) ?? "null"), { role: "user", message: { content: [{ type: "text", text: "hello" }] } })
  const assistant = formatSingleMessageJsonl({ role: "assistant", content: [{ type: "text", text: "visible" }, { type: "reasoning", text: "thought" }, { type: "image" }, { type: "file", filename: "a.txt" }, { type: "tool-call", toolName: "run", args: { a: 1 } }] }) ?? ""
  const parsed = JSON.parse(assistant)
  assert.equal(parsed.message.content[0].text, "visible\n[Image]\n[File: a.txt]\n\nthought")
  assert.deepEqual(parsed.message.content[1], { type: "tool_use", name: "run", input: { a: 1 } })
  assert.equal(formatSingleMessageJsonl({ role: "assistant", content: [] }), undefined)
})

test("the thinking and context a reader should not see are stripped", () => {
  const assistant = formatSingleMessageJsonl({ role: "assistant", content: "some <thinking>hidden response</thinking> visible" }) ?? ""
  assert.doesNotMatch(assistant, /hidden|think/)
  assert.match(assistant, /visible/)
  const user = formatSingleMessageJsonl({ role: "user", content: "<user_info>x</user_info> actual" }) ?? ""
  assert.doesNotMatch(user, /<user_info>/)
  assert.match(user, /actual/)
})

test("a full write writes the transcript file, and an incremental one continues it", async () => {
  await withTempDir(async (dir) => {
    const mirror = new LegacyFileTranscriptMirror(dir)
    const blobs = new Map()
    blobs.set(id(1), encode({ role: "user", content: "hello there" }))
    blobs.set(id(2), encode({ role: "assistant", content: [{ type: "text", text: "hi" }] }))
    const store = makeStore(blobs)
    const state = { summaryArchives: [], rootPromptMessagesJson: [id(1), id(2)], turns: [] }
    assert.equal(await mirror.writeFull(createContext(), "conv", state, store), true)
    const content = readFileSync(mirror.jsonlPathFor("conv"), "utf8")
    assert.match(content, /hello there/)
    assert.match(content, /"hi"/)
    assert.equal(await mirror.writeIncremental(createContext(), "conv", state, store, 0), null, "an incremental write from nothing is a full write")
    assert.equal(await mirror.writeIncremental(createContext(), "conv", state, store, 3), null, "a shorter transcript is not continued")
    assert.equal(await mirror.writeIncremental(createContext(), "conv", state, store, 2), 2, "an incremental write with nothing new keeps the count")
    const empty = new LegacyFileTranscriptMirror(dir)
    assert.equal(await empty.writeFull(createContext(), "empty", { summaryArchives: [], rootPromptMessagesJson: [], turns: [] }, store), true)
    assert.equal(await empty.writeFull(createContext(), "missing", { summaryArchives: [], rootPromptMessagesJson: [id(9)], turns: [] }, store), false, "a state naming only a message the store does not have writes nothing, and says so")
    assert.equal(await empty.writeFull(createContext(), "mixed", { summaryArchives: [], rootPromptMessagesJson: [id(1), id(9)], turns: [] }, store), true, "a missing message beside a read one is skipped")
    assert.match(readFileSync(empty.jsonlPathFor("mixed"), "utf8"), /hello there/)
  })
})

test("a full write does not replace a transcript that has more lines already", async () => {
  await withTempDir(async (dir) => {
    const state = { summaryArchives: [], rootPromptMessagesJson: [id(1), id(2)], turns: [] }
    const store = makeStore(new Map([[id(1), encode({ role: "user", content: "a" })], [id(2), encode({ role: "assistant", content: "b" })]]))
    const longer = new LegacyFileTranscriptMirror(dir)
    await longer.writeFull(createContext(), "conv", state, store)
    const before = readFileSync(longer.jsonlPathFor("conv"), "utf8")
    const shorterState = { summaryArchives: [], rootPromptMessagesJson: [id(1)], turns: [] }
    await longer.writeFull(createContext(), "conv", shorterState, store)
    assert.equal(readFileSync(longer.jsonlPathFor("conv"), "utf8"), before, "the longer transcript is kept")
    assert.equal(before.split("\n").filter((line) => line.length > 0).length >= 2, true)
  })
})

test("an oversized blob is said as omitted, and a missing one is skipped", async () => {
  await withTempDir(async (dir) => {
    const big = new Uint8Array(5_000_001)
    big.fill(120)
    const blobs = new Map([[id(1), big], [id(2), encode({ role: "user", content: "kept" })]])
    const store = makeStore(blobs)
    const mirror = new LegacyFileTranscriptMirror(dir)
    await mirror.writeFull(createContext(), "conv", { summaryArchives: [], rootPromptMessagesJson: [id(1), id(2), id(9)], turns: [] }, store)
    const content = readFileSync(mirror.jsonlPathFor("conv"), "utf8")
    assert.match(content, /Oversize transcript blob omitted: 5\.0 MB/)
    assert.match(content, /kept/)
  })
})
