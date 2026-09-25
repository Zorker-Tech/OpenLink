import { test } from "node:test"
import assert from "node:assert/strict"
import fs from "node:fs"
import os from "node:os"
import path from "node:path"

import { LocalReadExecutor } from "../../source/packages/local-exec/read.ts"
import { ShellOutputNotificationObserver } from "../../source/packages/local-exec/background-shell-observability.ts"
import { createContext } from "../../source/packages/context/context.ts"

// ---------------------------------------------------------------------------------------------
// Reading a file
// ---------------------------------------------------------------------------------------------

const allowAll = { shouldBlockRead: () => false }

function withWorkspace(run: (workspace: string) => Promise<void>) {
  const workspace = fs.mkdtempSync(path.join(os.tmpdir(), "slate-read-"))
  return run(workspace).finally(() => fs.rmSync(workspace, { recursive: true, force: true }))
}

test("a text file is read with the lines it has", async () => {
  await withWorkspace(async (workspace) => {
    fs.writeFileSync(path.join(workspace, "notes.txt"), "one\ntwo\nthree\n")
    const executor = new LocalReadExecutor(allowAll, workspace)
    const result = await executor.execute(createContext(), { path: "notes.txt" })

    assert.equal(result.result.case, "success")
    assert.equal(result.result.value?.output.case, "content")
    assert.equal(result.result.value?.output.value, "one\ntwo\nthree\n")
    assert.equal(result.result.value?.totalLines, 4)
    assert.equal(result.result.value?.fileSize, 14n)
    assert.equal(result.result.value?.truncated, false)
  })
})

test("a range is applied to what was read", async () => {
  await withWorkspace(async (workspace) => {
    fs.writeFileSync(path.join(workspace, "notes.txt"), "one\ntwo\nthree\nfour\n")
    const executor = new LocalReadExecutor(allowAll, workspace)
    const result = await executor.execute(createContext(), { path: "notes.txt", offset: 2, limit: 2 })

    const success = result.result.case === "success" ? result.result.value : undefined
    assert.equal(success?.output.value, "two\nthree")
    assert.equal(success?.totalLines, 5)
    assert.equal(success?.rangeApplied, true)
  })
})

test("what cannot be read is reported as its own answer", async () => {
  await withWorkspace(async (workspace) => {
    fs.mkdirSync(path.join(workspace, "a-directory"))
    const executor = new LocalReadExecutor(allowAll, workspace)

    const missing = await executor.execute(createContext(), { path: "not-here.txt" })
    assert.equal(missing.result.case, "fileNotFound")

    const directory = await executor.execute(createContext(), { path: "a-directory" })
    assert.equal(directory.result.case, "invalidFile")
    assert.match(directory.result.value?.reason ?? "", /is a directory/)

    // A file whose bytes say it is a binary the model cannot read is refused rather than shown as mojibake.
    // A format that is binary and that the model has no way to read: an archive.
    fs.writeFileSync(path.join(workspace, "blob.bin"), Buffer.from([0x50, 0x4b, 0x03, 0x04, 0, 0, 0, 0, 0, 0, 0, 0]))
    const binary = await executor.execute(createContext(), { path: "blob.bin" })
    assert.equal(binary.result.case, "invalidFile")
    assert.match(binary.result.value?.reason ?? "", /Binary files of type .bin are not supported/)
  })
})

test("a file that claims to be an image but cannot be decoded fails rather than hanging the turn", async () => {
  await withWorkspace(async (workspace) => {
    fs.writeFileSync(path.join(workspace, "broken.png"), Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 0]))
    const executor = new LocalReadExecutor(allowAll, workspace)
    const result = await executor.execute(createContext(), { path: "broken.png" })
    // The read is bounded by the watchdog, so a file that cannot be decoded is an answer rather than a wait.
    assert.equal(result.result.case, "error")
  })
})

test("a path the user may not read is refused before anything is read", async () => {
  await withWorkspace(async (workspace) => {
    fs.writeFileSync(path.join(workspace, "secret.txt"), "hidden")
    const executor = new LocalReadExecutor({ shouldBlockRead: (candidate) => candidate.endsWith("secret.txt") }, workspace)
    const result = await executor.execute(createContext(), { path: "secret.txt" })

    assert.equal(result.result.case, "permissionDenied")
    assert.equal(result.result.value?.path, path.join(workspace, "secret.txt"))
  })
})

test("a terminal's output is read as records rather than as text", async () => {
  await withWorkspace(async (workspace) => {
    // A terminal is a file the platform keeps under the project it manages, named by its id.
    const terminals = path.join(workspace, ".slate", "projects", "workspace-1", "terminals")
    fs.mkdirSync(terminals, { recursive: true })
    fs.writeFileSync(path.join(terminals, "42.txt"), "the command's output\nsecond line\n")

    const executor = new LocalReadExecutor(allowAll, workspace)
    const result = await executor.execute(createContext(), { path: ".slate/projects/workspace-1/terminals/42.txt" })
    assert.equal(result.result.case, "success")
    assert.equal(result.result.value?.output.case, "content")
    assert.equal(result.result.value?.output.value, "the command's output\nsecond line\n")
  })
})

// ---------------------------------------------------------------------------------------------
// Watching a background shell's output
// ---------------------------------------------------------------------------------------------

function createObserver(config: { pattern: string; reason: string; notificationLimit?: number }) {
  const enqueued: Array<Record<string, unknown>> = []
  const observer = new ShellOutputNotificationObserver({
    shellId: 1,
    outputPath: "/project/.slate/projects/workspace-1/terminals/1.txt",
    config,
    conversationId: "conversation-1",
    registry: { enqueue: (wakeup: Record<string, unknown>) => enqueued.push(wakeup) },
  })
  return { observer, enqueued }
}

test("output that matches is reported once, and output that does not is not", () => {
  const { observer, enqueued } = createObserver({ pattern: "ERROR", reason: "the build failed" })
  observer.observe("all good\nstill good\n")
  assert.equal(enqueued.length, 0)

  observer.observe("ERROR: the build failed\n")
  observer.finish()
  assert.equal(enqueued.length, 1)
  const payload = enqueued[0]?.payload as { detail?: string } | undefined
  assert.equal(enqueued[0]?.conversationId, "conversation-1")
  // The notification says what matched and where the output is, so the user can look at it.
  assert.match(String(payload?.detail), /ERROR/)
  assert.equal(typeof (enqueued[0]?.payload as { outputPath?: string } | undefined)?.outputPath, "string")
})

test("a match that straddles two reads is still seen", () => {
  const { observer, enqueued } = createObserver({ pattern: "ERROR", reason: "the build failed" })
  observer.observe("ERR")
  observer.observe("OR: the build failed")
  observer.finish()
  assert.equal(enqueued.length, 1)
})

test("a shell that writes more matches than the limit stops being reported", () => {
  const { observer, enqueued } = createObserver({ pattern: "ERROR", reason: "the build failed", notificationLimit: 1 })
  observer.observe("ERROR one\n")
  // The match itself, and the notice that no more matches will be reported.
  assert.equal(enqueued.length, 2)
  assert.match(String((enqueued[1]?.payload as { detail?: string } | undefined)?.detail), /has reached the notification limit/)
  // The limit has been reached, so a later match is not reported again.
  observer.observe("ERROR two\n")
  observer.finish()
  assert.equal(enqueued.length, 2)
})

test("a match that is too long to send is described rather than pasted", () => {
  const { observer, enqueued } = createObserver({ pattern: "ERROR[\\s\\S]*", reason: "the build failed" })
  observer.observe(`ERROR ${"x".repeat(6_000)}`)
  observer.finish()
  const payload = enqueued[0]?.payload as { detail?: string } | undefined
  assert.match(String(payload?.detail), /is \d+ characters; omitted from notification detail/)
})

test("a notification's own title is cut to what a notification can hold", () => {
  const { observer, enqueued } = createObserver({ pattern: "ERROR", reason: "x".repeat(600) })
  observer.observe("ERROR: the build failed\n")
  const title = (enqueued[0]?.payload as { title?: string } | undefined)?.title ?? ""
  assert.equal(title.length, 503)
  assert.equal(title.endsWith("..."), true)
})

test("a pattern nobody could mean is refused when the observer is built", () => {
  assert.throws(
    () => createObserver({ pattern: "x".repeat(501), reason: "too long" }),
    /Output notification pattern exceeds 500 characters/,
  )
})
