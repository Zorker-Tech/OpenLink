import { test } from "node:test"
import assert from "node:assert/strict"
import fs from "node:fs"
import os from "node:os"
import path from "node:path"

import { LocalReadExecutor } from "../../source/packages/local-exec/read.ts"
import { FileLoggingShellFactory, NotifyingBackgroundShellFactory, ShellOutputNotificationObserver } from "../../source/packages/local-exec/background-shell-observability.ts"
import { createContext } from "../../source/packages/context/context.ts"

// ---------------------------------------------------------------------------------------------
// Reading a file
// ---------------------------------------------------------------------------------------------

const allowAll = { shouldBlockRead: () => false }

function withWorkspace(run: (workspace: string) => Promise<void>) {
  const workspace = fs.mkdtempSync(path.join(os.tmpdir(), "slate-read-"))
  return run(workspace).finally(() => fs.rmSync(workspace, { recursive: true, force: true }))
}


// ---------------------------------------------------------------------------------------------
// Watching a shell that keeps running
// ---------------------------------------------------------------------------------------------

const registryOf = () => {
  const enqueued: { payload: Record<string, unknown> }[] = []
  return { enqueued, enqueue: (event: { payload: Record<string, unknown> }) => enqueued.push(event) }
}
const observerOf = (config: Record<string, unknown>, registry = registryOf(), extra: Record<string, unknown> = {}) =>
  new ShellOutputNotificationObserver({ shellId: 7, outputPath: "/terminals/7.txt", config: config as never, conversationId: "conv-1", registry: registry as never, ...extra })

test("a shell's output notifies once at first, then in a batch, and when it is limited", () => {
  const registry = registryOf()
  const observer = observerOf({ pattern: "ERR", reason: "when it fails", notificationLimit: 3 }, registry)
  observer.observe("ERR")
  assert.equal(registry.enqueued.length, 1)
  assert.equal(registry.enqueued[0]?.payload.title, "when it fails")
  assert.match(String(registry.enqueued[0]?.payload.detail), /This is occurrence number 1\. Matched text: ERR\./)
  observer.observe("ERR ERR ERR")
  // The batch and the limit notification are flushed once the third occurrence is reached.
  assert.equal(registry.enqueued.length, 3)
  assert.match(String(registry.enqueued[1]?.payload.detail), /2 more times since the previous notification\. The title message is being displayed to the user\. Latest match: ERR\./)
  assert.equal(registry.enqueued[2]?.payload.title, "Notification limit reached (3)")
  assert.match(String(registry.enqueued[2]?.payload.detail), /matched \/ERR\/ 3 times and has reached the notification limit/)
  assert.match(String(registry.enqueued[2]?.payload.detail), /No further notifications will be sent/)
  observer.finish()
  observer.observe("ERR")
  assert.equal(registry.enqueued.length, 3)
})

test("a match split across two reads is still found, and a match already seen is not counted twice", () => {
  const registry = registryOf()
  const observer = observerOf({ pattern: "ERR", reason: "r" }, registry)
  observer.observe("E")
  observer.observe("RR")
  observer.finish()
  assert.equal(registry.enqueued.length, 1)
  assert.match(String(registry.enqueued[0]?.payload.detail), /Matched text: ERR\./)
  // A second full read repeats the match once: the old text is not counted again, only the new one.
  const repeated = registryOf()
  const repeating = observerOf({ pattern: "ERR", reason: "r" }, repeated)
  repeating.observe("ERR")
  repeating.observe("ERR")
  repeating.finish()
  assert.equal(repeated.enqueued.length, 2)
  assert.match(String(repeated.enqueued[1]?.payload.detail), /This is occurrence number 2\./)
})

test("a long reason is cut and a long match is not quoted", () => {
  const registry = registryOf()
  observerOf({ pattern: "x+", reason: "r".repeat(600) }, registry).observe("x".repeat(6000))
  assert.equal(String(registry.enqueued[0]?.payload.title).length, 503)
  assert.match(String(registry.enqueued[0]?.payload.detail), /is 6000 characters; omitted from notification detail\./)
  const fallback = registryOf()
  observerOf({ pattern: "x", reason: "   " }, fallback, { toolCallId: "call-1" }).observe("x")
  assert.equal(fallback.enqueued[0]?.payload.title, "Shell output contains /x/")
  assert.equal(fallback.enqueued[0]?.payload.toolCallId, "call-1")
  const withoutCallId = registryOf()
  observerOf({ pattern: "x", reason: "r" }, withoutCallId).observe("x")
  assert.equal("toolCallId" in (withoutCallId.enqueued[0]?.payload ?? {}), false)
})

test("a pattern longer than the notification limit is refused", () => {
  assert.throws(
    () => new ShellOutputNotificationObserver({ shellId: 1, outputPath: "/o", config: { pattern: "x".repeat(501), reason: "r" }, conversationId: "c", registry: registryOf() as never }),
    /Output notification pattern exceeds 500 characters/,
  )
})

test("a shell factory watches a shell's output and an adopted shell's first output", async () => {
  const registry = registryOf()
  const spawned: { context: unknown; executor: { execute: (ctx: unknown, args: unknown) => AsyncIterable<unknown> } }[] = []
  const adopted: { eventIterator: { next: () => Promise<unknown> } }[] = []
  const shell = { kind: "shell" }
  const inner = {
    spawn: async (context: unknown, executor: never) => { spawned.push({ context: context as never, executor: executor as never }); return shell as never },
    adopt: async (state: { eventIterator: never }) => { adopted.push(state as never); return shell as never },
  }
  const factory = new NotifyingBackgroundShellFactory(inner as never, "/project", registry as never)
  await factory.spawn({ shellId: 2, conversationId: "conv", toolCallId: "call", command: "c", workingDirectory: "/w", outputNotification: { pattern: "ERR", reason: "r" } } as never, { execute: async function* () { yield { type: "stdout", data: "ERR" }; yield { type: "exit", code: 0 } } })
  const events = []
  for await (const event of spawned[0]!.executor.execute({}, {})) events.push(event)
  assert.equal(events.length, 2)
  assert.equal(registry.enqueued.length, 1)
  const iterator = { next: async () => ({ done: false, value: { type: "stdout", data: "ERR" } }), return: async () => ({ done: true, value: undefined }) }
  await factory.adopt({ shellId: 3, conversationId: "conv", command: "c", workingDirectory: "/w", initialOutput: "ERR", eventIterator: iterator, outputNotification: { pattern: "ERR", reason: "r" } } as never)
  await adopted[0]!.eventIterator.next()
  await (adopted[0] as unknown as { eventIterator: { return: () => Promise<unknown> } }).eventIterator.return()
  assert.equal(registry.enqueued.length, 3)
  // A shell with no notification config is handed on untouched.
  const untouched = { spawn: async () => shell as never, adopt: async () => shell as never }
  const plain = new NotifyingBackgroundShellFactory(untouched as never, "/project", registry as never)
  await plain.spawn({ shellId: 4, command: "c", workingDirectory: "/w" } as never, {} as never)
})

test("a shell is logged to its terminal file, with its footer and its stdin", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "slate-log-"))
  try {
    const spawned: { executor: { execute: (ctx: unknown, args: unknown) => AsyncIterable<unknown> } }[] = []
    const inner = { spawn: async (_context: unknown, executor: never) => { spawned.push({ executor: executor as never }); return { kind: "shell" } as never }, adopt: async () => ({ kind: "shell" } as never) }
    const factory = new FileLoggingShellFactory(inner as never, dir)
    const stdinCalls: unknown[] = []
    const stdin: { write: (chunk?: unknown) => boolean; end: (chunk?: unknown) => unknown } = { write: (chunk?: unknown) => { stdinCalls.push(chunk); return true }, end: (chunk?: unknown) => { stdinCalls.push(chunk); return stdin } }
    await factory.spawn({ shellId: 11, command: "echo hi", workingDirectory: dir, description: 'say "hi"' } as never, {
      execute: async function* () {
        yield { type: "stdout", data: "hello\n" }
        yield { type: "stdin_ready", pid: 9, stdin }
        stdin.write("hello")
        stdin.end()
        yield { type: "exit", code: 0 }
      },
    })
    for await (const _event of spawned[0]!.executor.execute({}, { showElapsedTime: true })) { /* logged */ }
    const content = fs.readFileSync(path.join(dir, "terminals", "11.txt"), "utf8")
    assert.match(content, /^---\ncwd: "/)
    assert.match(content, /command: "echo hi"\ntitle: "say \\"hi\\""\nstatus: succeeded/)
    assert.match(content, /started_at: .+\nrunning_for_ms: \d+ +\n---\nhello\n/)
    assert.match(content, /\[stdin\] hello\n/)
    assert.match(content, /\n---\nexit_code: 0\nelapsed_ms: \d+\nended_at: .+\n---\n$/)
    assert.equal(stdinCalls.length, 2)
  } finally {
    fs.rmSync(dir, { recursive: true, force: true })
  }
})

test("an aborted or failing shell says how it ended, and an adopted one is logged from its start", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "slate-log-"))
  try {
    const spawned: { executor: { execute: (ctx: unknown, args: unknown) => AsyncIterable<unknown> } }[] = []
    const inner = { spawn: async (_context: unknown, executor: never) => { spawned.push({ executor: executor as never }); return { kind: "shell" } as never }, adopt: async () => ({ kind: "shell" } as never) }
    const factory = new FileLoggingShellFactory(inner as never, dir)
    await factory.spawn({ shellId: 12, command: "sleep", workingDirectory: dir } as never, { execute: async function* () { yield { type: "exit", aborted: true, code: null } } })
    for await (const _event of spawned[0]!.executor.execute({}, {})) { /* logged */ }
    const abortedContent = fs.readFileSync(path.join(dir, "terminals", "12.txt"), "utf8")
    assert.match(abortedContent, /status: aborted {2}\n[\s\S]*exit_code: unknown/)
    assert.equal(abortedContent.includes("elapsed_ms:"), false)
    const adopted: { eventIterator: { next: () => Promise<{ done: boolean; value?: unknown }>; return: () => Promise<{ done: boolean; value: undefined }> } }[] = []
    const adopting = { spawn: async () => ({ kind: "shell" } as never), adopt: async (state: never) => { adopted.push(state as never); return { kind: "shell" } as never } }
    const adoptingFactory = new FileLoggingShellFactory(adopting as never, dir)
    const iterator = { next: async () => ({ done: false, value: { type: "stdout", data: "adopted\n" } }), return: async () => ({ done: true, value: undefined }) }
    await adoptingFactory.adopt({ shellId: 21, command: "cat", workingDirectory: dir, description: "adopted", startTime: Date.now() - 1_000, pid: 42, showElapsedTime: true, initialOutput: "first\n", eventIterator: iterator, abortController: new AbortController() } as never)
    await adopted[0]!.eventIterator.next()
    await adopted[0]!.eventIterator.return()
    const content = fs.readFileSync(path.join(dir, "terminals", "21.txt"), "utf8")
    assert.match(content, /pid: 42\n/)
    assert.match(content, /title: "adopted"/)
    assert.match(content, /running_for_ms: \d+ +\n/)
    assert.match(content, /---\nfirst\nadopted\n/)
  } finally {
    fs.rmSync(dir, { recursive: true, force: true })
  }
})

test("a text file is read with the lines it has", async () => {
  await withWorkspace(async (workspace) => {
    fs.writeFileSync(path.join(workspace, "notes.txt"), "one\ntwo\nthree\n")
    const executor = new LocalReadExecutor(allowAll, workspace)
    const result = await executor.execute(createContext(), { path: "notes.txt" })

    assert.equal(result.kind, "success")
    assert.equal(result.kind === "success" ? result.output.kind : "", "text")
    assert.equal(result.kind === "success" && result.output.kind === "text" ? result.output.text : "", "one\ntwo\nthree\n")
    assert.equal(result.kind === "success" ? result.totalLines : 0, 4)
    assert.equal(result.kind === "success" ? result.fileSize : 0, 14)
    assert.equal(result.kind === "success" ? result.truncated : true, false)
  })
})

test("a range is applied to what was read", async () => {
  await withWorkspace(async (workspace) => {
    fs.writeFileSync(path.join(workspace, "notes.txt"), "one\ntwo\nthree\nfour\n")
    const executor = new LocalReadExecutor(allowAll, workspace)
    const result = await executor.execute(createContext(), { path: "notes.txt", offset: 2, limit: 2 })

    const success = result.kind === "success" ? result : undefined
    assert.equal(success?.output.kind === "text" ? success.output.text : undefined, "two\nthree")
    assert.equal(success?.totalLines, 5)
    assert.equal(success?.rangeApplied, true)
  })
})

test("what cannot be read is reported as its own answer", async () => {
  await withWorkspace(async (workspace) => {
    fs.mkdirSync(path.join(workspace, "a-directory"))
    const executor = new LocalReadExecutor(allowAll, workspace)

    const missing = await executor.execute(createContext(), { path: "not-here.txt" })
    assert.equal(missing.kind, "not_found")

    const directory = await executor.execute(createContext(), { path: "a-directory" })
    assert.equal(directory.kind, "invalid_file")
    assert.match(directory.kind === "invalid_file" ? directory.reason : "", /is a directory/)

    // A file whose bytes say it is a binary the model cannot read is refused rather than shown as mojibake.
    // A format that is binary and that the model has no way to read: an archive.
    fs.writeFileSync(path.join(workspace, "blob.bin"), Buffer.from([0x50, 0x4b, 0x03, 0x04, 0, 0, 0, 0, 0, 0, 0, 0]))
    const binary = await executor.execute(createContext(), { path: "blob.bin" })
    assert.equal(binary.kind, "invalid_file")
    assert.match(binary.kind === "invalid_file" ? binary.reason : "", /Binary files of type .bin are not supported/)
  })
})

test("a file that claims to be an image but cannot be decoded fails rather than hanging the turn", async () => {
  await withWorkspace(async (workspace) => {
    fs.writeFileSync(path.join(workspace, "broken.png"), Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 0]))
    const executor = new LocalReadExecutor(allowAll, workspace)
    const result = await executor.execute(createContext(), { path: "broken.png" })
    // The read is bounded by the watchdog, so a file that cannot be decoded is an answer rather than a wait.
    assert.equal(result.kind, "error")
  })
})

test("a path the user may not read is refused before anything is read", async () => {
  await withWorkspace(async (workspace) => {
    fs.writeFileSync(path.join(workspace, "secret.txt"), "hidden")
    const executor = new LocalReadExecutor({ shouldBlockRead: (candidate) => candidate.endsWith("secret.txt") }, workspace)
    const result = await executor.execute(createContext(), { path: "secret.txt" })

    assert.equal(result.kind, "permission_denied")
    assert.equal(result.kind === "permission_denied" ? result.path : "", path.join(workspace, "secret.txt"))
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
    assert.equal(result.kind, "success")
    assert.equal(result.kind === "success" ? result.output.kind : "", "text")
    assert.equal(result.kind === "success" && result.output.kind === "text" ? result.output.text : "", "the command's output\nsecond line\n")
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
