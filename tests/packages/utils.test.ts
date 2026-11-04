import { test } from "node:test"
import assert from "node:assert/strict"
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import path from "node:path"

import { captureSync } from "../../source/packages/utils/attempt.ts"
import { getFirstItem } from "../../source/packages/utils/async-iterator.ts"
import { canonicalizeWorkspacePath, isWorkspaceCanvasDocument } from "../../source/packages/utils/canvas-paths.ts"
import {
  getAdminCommandDenylistRuleError,
  normalizeAdminCommandDenylistText,
  parseAdminCommandDenylistColonRule,
} from "../../source/packages/utils/command-denylist.ts"
import { commandMatchesPattern } from "../../source/packages/utils/command-glob.ts"
import { getSafeConversationId, MAX_CONVERSATION_ID_LENGTH } from "../../source/packages/utils/conversation-paths.ts"
import { findActualExecutable } from "../../source/packages/utils/executable-lookup.ts"
import {
  isAzureDevopsServicesHost,
  isBitbucketCloudHost,
  isGitHubDotComHost,
  isGitLabHost,
  parseAzureDevopsRepositoryPathSegments,
  parseBitbucketRepositoryPathSegments,
  parseGitHubRepositoryPathSegments,
  parseGitLabRepositoryPathSegments,
} from "../../source/adapters/interop/scm/git-host-url-adapter.ts"
import { MAX_IMAGE_DIMENSION, resizeImageBufferIfNeeded, targetDimensions } from "../../source/packages/utils/image-resize.ts"
import { getImageCodecs } from "../../source/packages/utils/image-codecs.ts"
import { extractTerminalId, isAgentToolOutputFile, isAgentTranscriptPath, isTerminalsDirectory, sanitizeFilename } from "../../source/packages/utils/managed-paths.ts"
import { isLargeContextModel } from "../../source/packages/utils/model-markers.ts"
import { isPathWithin, isWorktreesPath, normalizeToUnixPath, resolvePath, resolveRealPathStrict, shouldBlockWorktreePath, WORKTREE_GUARD_ERROR } from "../../source/packages/utils/paths.ts"
import { asyncMapValues, PromiseQueue, TimeoutError, withTimeout } from "../../source/packages/utils/promise-tools.ts"
import { spawnPromise } from "../../source/packages/utils/process-spawn.ts"
import { shouldRebuildUserInfoForPullRequestRule } from "../../source/packages/utils/pull-request-guidance.ts"
import { ReplayableAsyncIterable } from "../../source/packages/utils/replayable-async-iterable.ts"
import { buildWebSearchYearGuidance, getIsoDateYearString } from "../../source/packages/utils/search-year-guidance.ts"
import { countLines, getFormatForFile, isVideoFilePath, readText } from "../../source/packages/utils/text-encoding.ts"
import { LATIN1_ENCODING, mapToIconvEncoding, normalizeEncodingName, stripUtf8Bom, UTF8_ENCODING } from "../../source/packages/utils/encoding-names.ts"
import { TTLCache } from "../../source/packages/utils/ttl-cache.ts"
import { decodeWebp, encodeWebp, isWebp, webpSize, registerWebpCodec } from "../../source/packages/utils/webp.ts"
import { createWritableIterable, WriteIterableClosedError } from "../../source/packages/utils/writable-iterable.ts"

async function withTempDirectory<T>(run: (directory: string) => Promise<T>): Promise<T> {
  const directory = await mkdtemp(path.join(tmpdir(), "slate-utils-"))
  try {
    return await run(directory)
  } finally {
    await rm(directory, { recursive: true, force: true })
  }
}

test("reading text detects encoding and line endings, and refuses binary files", async () => {
  await withTempDirectory(async directory => {
    const utf8 = path.join(directory, "utf8.txt")
    await writeFile(utf8, "hello\nworld\n")
    assert.equal(await readText(utf8), "hello\nworld\n")
    assert.deepEqual(await getFormatForFile(utf8), {
      encoding: "UTF-8",
      lineEnding: "LF",
      isBinaryFile: false,
      isImageFile: false,
      isVideoFile: false,
    })

    const crlf = path.join(directory, "crlf.txt")
    await writeFile(crlf, "one\r\ntwo\r\nthree\r\n")
    assert.equal(await readText(crlf), "one\ntwo\nthree\n", "line endings are normalized on read")

    const withBom = path.join(directory, "bom.txt")
    await writeFile(withBom, Buffer.concat([Buffer.from([239, 187, 191]), Buffer.from("content")]))
    assert.equal(await readText(withBom), "content", "the byte-order mark is not content")

    const latin1 = path.join(directory, "latin1.txt")
    await writeFile(latin1, Buffer.from([0x63, 0x61, 0x66, 0xe9]))
    assert.equal(await readText(latin1, LATIN1_ENCODING), "café")
    assert.equal(await readText(latin1), "café", "a hint is not needed to read it")

    const binary = path.join(directory, "blob.bin")
    await writeFile(binary, Buffer.from([0, 1, 2, 3, 0, 255]))
    await assert.rejects(readText(binary), /Binary file cannot be decoded as text/)

    const video = path.join(directory, "clip.mp4")
    await writeFile(video, Buffer.from([0, 0, 0, 24, 102, 116, 121, 112]))
    assert.equal(isVideoFilePath(video), true)
    assert.equal(isVideoFilePath(path.join(directory, "clip.MP4")), true)
    assert.equal(isVideoFilePath(utf8), false)
    assert.equal((await getFormatForFile(video)).isVideoFile, true)
  })
})

test("counting lines and naming encodings are the platform's own conventions", () => {
  assert.equal(countLines(""), 1)
  assert.equal(countLines("one"), 1)
  assert.equal(countLines("one\ntwo\n"), 3)
  assert.equal(normalizeEncodingName("UTF-8"), UTF8_ENCODING)
  assert.equal(normalizeEncodingName("latin-1"), LATIN1_ENCODING)
  assert.equal(normalizeEncodingName("utf-8-bom"), "utf8bom")
  assert.equal(mapToIconvEncoding("windows-1252"), "cp1252")
  assert.equal(mapToIconvEncoding("utf8"), "utf8")
  assert.equal(stripUtf8Bom("\ufeffx"), "x")
  assert.equal(stripUtf8Bom("x"), "x")
})

test("a writable iterable hands values to its reader in order and wakes it on close", async () => {
  const stream = createWritableIterable<number>()
  const reader = (async () => {
    const seen: number[] = []
    for await (const value of stream) seen.push(value)
    return seen
  })()
  await stream.write(1)
  await stream.write(2)
  stream.close()
  assert.deepEqual(await reader, [1, 2])

  const failing = createWritableIterable<string>()
  const failure = new Error("producer failed")
  const failingReader = (async () => {
    const seen: string[] = []
    await assert.rejects(async () => {
      for await (const value of failing) seen.push(value)
    }, /producer failed/)
    return seen
  })()
  await failing.write("first")
  failing.throw(failure)
  assert.deepEqual(await failingReader, ["first"])

  const closed = createWritableIterable<number>()
  closed.close()
  await assert.rejects(closed.write(1), WriteIterableClosedError)
})

test("a writable iterable preserves falsy failure reasons for waiting readers and later writes", async () => {
  for (const reason of [undefined, null, false, 0, ""] as const) {
    const stream = createWritableIterable<number>()
    const reader = stream[Symbol.asyncIterator]()
    const waiting = reader.next()
    stream.throw(reason)

    assert.deepEqual(await Promise.allSettled([waiting]), [{ status: "rejected", reason }])
    assert.deepEqual(await Promise.allSettled([reader.next()]), [{ status: "rejected", reason }])
    assert.deepEqual(await Promise.allSettled([stream.write(1)]), [{ status: "rejected", reason }])
  }
})

test("a replayable iterable gives every consumer the whole sequence", async () => {
  async function* source() {
    yield "a"
    yield "b"
    yield "c"
  }
  const replayable = new ReplayableAsyncIterable(source())
  const first = (async () => { const seen: string[] = []; for await (const value of replayable) seen.push(value); return seen })()
  const second = (async () => { const seen: string[] = []; for await (const value of replayable) seen.push(value); return seen })()
  assert.deepEqual(await first, ["a", "b", "c"])
  assert.deepEqual(await second, ["a", "b", "c"], "a late consumer still sees everything")

  const failing = new ReplayableAsyncIterable((async function* () {
    yield 1
    throw new Error("stream broke")
  })())
  const consumer = (async () => { const seen: number[] = []; await assert.rejects(async () => { for await (const value of failing) seen.push(value) }, /stream broke/); return seen })()
  assert.deepEqual(await consumer, [1])
})

test("the first item can be peeked at without consuming the rest", async () => {
  async function* numbers() {
    yield 1
    yield 2
    yield 3
  }
  const peeked = await getFirstItem(numbers())
  assert.ok(peeked)
  assert.equal(peeked.firstItem, 1)
  const rest: number[] = []
  for await (const value of peeked.rest) rest.push(value)
  assert.deepEqual(rest, [2, 3])

  assert.equal(await getFirstItem((async function* () {})()), undefined)
})

test("a TTL cache expires entries on the injected clock", () => {
  let now = 1_000
  const cache = new TTLCache<string, number>({ ttlMs: 500, now: () => now })
  cache.set("a", 1)
  assert.equal(cache.get("a"), 1)
  assert.equal(cache.has("a"), true)
  now += 499
  assert.equal(cache.get("a"), 1, "still inside the window")
  now += 1
  assert.equal(cache.get("a"), undefined, "expiry is inclusive of the deadline")
  assert.equal(cache.has("a"), false)

  cache.set("b", 2)
  assert.equal(cache.delete("b"), true)
  assert.equal(cache.get("b"), undefined)
  assert.equal(cache.delete("b"), false)
  cache.set("c", 3)
  cache.clear()
  assert.equal(cache.get("c"), undefined)

  assert.throws(() => new TTLCache({ ttlMs: 0 }), /positive ttlMs/)
  assert.throws(() => new TTLCache({ ttlMs: -1 }), /positive ttlMs/)
  assert.throws(() => new TTLCache({ ttlMs: Number.NaN }), /positive ttlMs/)
  assert.throws(() => new TTLCache({ ttlMs: Number.POSITIVE_INFINITY }), /positive ttlMs/)
  const dynamic = new TTLCache<string, number>({ ttlMs: () => 100, now: () => now })
  dynamic.set("d", 4)
  assert.equal(dynamic.get("d"), 4)

  const absentValue = new TTLCache<string, undefined>({ ttlMs: 10, now: () => now })
  absentValue.set("present", undefined)
  assert.equal(absentValue.get("present"), undefined)
  assert.equal(absentValue.has("present"), true)
})

test("bounded concurrency keeps order and never exceeds its bound", async () => {
  let inFlight = 0
  let peak = 0
  const results = await asyncMapValues([5, 1, 3, 2], async value => {
    inFlight += 1
    peak = Math.max(peak, inFlight)
    await new Promise(resolve => setTimeout(resolve, value))
    inFlight -= 1
    return value * 2
  }, { max: 2 })
  assert.deepEqual(results, [10, 2, 6, 4], "results follow the input order, not the completion order")
  assert.ok(peak <= 2, `expected at most 2 in flight, saw ${peak}`)
  assert.deepEqual(await asyncMapValues([], () => 1), [])
})

test("a timeout rejects with a named error and leaves the promise alone otherwise", async () => {
  assert.equal(await withTimeout(Promise.resolve("done"), 50), "done")
  await assert.rejects(withTimeout(new Promise(() => {}), 5), TimeoutError)
  await assert.rejects(withTimeout(new Promise(() => {}), 5, "gave up"), /gave up/)
})

test("a promise queue runs work with a bound and drains on close", async () => {
  const queue = new PromiseQueue({ max: 2 })
  let inFlight = 0
  let peak = 0
  const tasks = Array.from({ length: 5 }, (_, index) => queue.enqueue(async () => {
    inFlight += 1
    peak = Math.max(peak, inFlight)
    await new Promise(resolve => setTimeout(resolve, 5))
    inFlight -= 1
    return index
  }))
  assert.deepEqual(await Promise.all(tasks), [0, 1, 2, 3, 4])
  assert.ok(peak <= 2, `expected at most 2 in flight, saw ${peak}`)

  const byKey = await queue.enqueueList(["a", "b"], async key => key.toUpperCase())
  assert.deepEqual([...byKey.entries()], [["a", "A"], ["b", "B"]])

  await queue.close()
  await assert.rejects(queue.enqueue(() => 1), /PromiseQueue is closed/)
})

test("closing waits for running work and rejects new submissions immediately", async () => {
  const queue = new PromiseQueue({ max: 1 })
  let releaseWork!: () => void
  const task = queue.enqueue(async () => {
    await new Promise<void>(resolve => { releaseWork = resolve })
    return "completed"
  })
  await new Promise<void>(resolve => setImmediate(resolve))

  let closed = false
  const closing = queue.close().then(() => { closed = true })
  await new Promise<void>(resolve => setImmediate(resolve))
  assert.equal(closed, false, "close stays pending while the task is running")
  await assert.rejects(queue.enqueue(() => "too late"), /PromiseQueue is closed/)

  releaseWork()
  assert.equal(await task, "completed")
  await closing
  assert.equal(closed, true)
})

test("a failing task rejects its own promise without stopping the queue", async () => {
  const queue = new PromiseQueue({ max: 1 })
  const failing = queue.enqueue(() => { throw new Error("task failed") })
  const succeeding = queue.enqueue(() => "ok")
  await assert.rejects(failing, /task failed/)
  assert.equal(await succeeding, "ok")
  await queue.close()
})

test("spawning a process returns its output, or fails with what it printed", async () => {
  const output = await spawnPromise(process.execPath, ["-e", "console.log('hello'); console.error('warned')"])
  assert.deepEqual(output.trim().split("\n").sort(), ["hello", "warned"], "the promise form concatenates both streams")

  const [stdout, stderr] = await spawnPromise(process.execPath, ["-e", "console.log('out'); console.error('err')"], { split: true })
  assert.equal(stdout.trim(), "out")
  assert.equal(stderr.trim(), "err")

  await assert.rejects(
    spawnPromise(process.execPath, ["-e", "console.error('bad thing'); process.exit(3)"]),
    (error: unknown) => {
      const failure = error as { exitCode?: number; message?: string }
      assert.equal(failure.exitCode, 3)
      assert.match(failure.message ?? "", /bad thing/)
      assert.match(failure.message ?? "", /exit code: 3/)
      return true
    },
  )

  await assert.rejects(
    spawnPromise(process.execPath, ["-e", "setTimeout(() => {}, 5000)"], { timeout: 100 }),
    /timed out after 100ms/,
  )
})

test("a bare executable name is resolved against PATH and remembered", () => {
  const resolved = findActualExecutable("node", ["--version"])
  assert.equal(resolved.args[0], "--version")
  assert.notEqual(resolved.cmd, "node", "a bare name is resolved to a path")
  assert.equal(findActualExecutable(process.execPath, ["x"]).cmd, process.execPath, "a path is already resolved")
  assert.equal(findActualExecutable("definitely-not-a-command-xyz", []).cmd, "definitely-not-a-command-xyz")
})

test("an executable path with a separator bypasses PATH lookup and keeps its arguments", () => {
  const executable = path.join("tools", "missing-command")
  const args = ["--mode", "fast"]
  assert.deepEqual(findActualExecutable(executable, args), { cmd: executable, args })
})

test("a path matcher skips nonmatching PATH entries and resolves the first match", async () => {
  await withTempDirectory(async directory => {
    const firstDirectory = path.join(directory, "first")
    const matchingDirectory = path.join(directory, "matching")
    await mkdir(firstDirectory)
    await mkdir(matchingDirectory)
    const executable = `slate-executable-${process.pid}`
    const firstCandidate = path.join(firstDirectory, executable)
    const matchingCandidate = path.join(matchingDirectory, executable)
    await writeFile(firstCandidate, "first")
    await writeFile(matchingCandidate, "matching")

    const previousPath = process.env.PATH
    try {
      process.env.PATH = [firstDirectory, matchingDirectory].join(path.delimiter)
      const args = ["--flag"]
      assert.deepEqual(findActualExecutable(executable, args, /matching/), { cmd: matchingCandidate, args })
    } finally {
      if (previousPath === undefined) delete process.env.PATH
      else process.env.PATH = previousPath
    }
  })
})

test("paths are resolved, and the worktree guard knows which checkouts are siblings", async () => {
  const home = process.env.HOME ?? "/root"
  assert.equal(resolvePath("~/file.txt"), path.join(home, "file.txt"))
  assert.equal(resolvePath("sub/file.txt", "/base"), "/base/sub/file.txt")
  assert.equal(resolvePath("/absolute/file.txt", "/base"), "/absolute/file.txt")
  assert.equal(normalizeToUnixPath("a\\b\\c"), "a/b/c")
  assert.equal(isPathWithin({ basePath: "/base", targetPath: "sub" }), true)
  assert.equal(isPathWithin({ basePath: "/base", targetPath: "../other" }), false)

  await withTempDirectory(async directory => {
    const existing = path.join(directory, "real")
    await writeFile(existing, "x")
    assert.equal(await resolveRealPathStrict(existing), await resolveRealPathStrict(existing))
    const resolvedDirectory = await resolveRealPathStrict(directory)
    assert.equal(
      await resolveRealPathStrict(path.join(directory, "not", "yet", "file.txt")),
      path.join(resolvedDirectory as string, "not", "yet", "file.txt"),
      "the existing prefix is resolved and the rest is appended",
    )
  })

  const worktree = "/repo/.slate/worktrees/app/feature"
  assert.equal(isWorktreesPath(worktree), true)
  assert.equal(isWorktreesPath("/repo/src"), false)
  assert.equal(WORKTREE_GUARD_ERROR.includes("worktrees"), true)
  assert.equal(
    shouldBlockWorktreePath({ targetPath: "/repo/.slate/worktrees/app/other", workspacePaths: [worktree] }),
    true,
    "another checkout of the same repository is off limits",
  )
  assert.equal(
    shouldBlockWorktreePath({ targetPath: "/repo/src/app.ts", workspacePaths: [worktree] }),
    false,
    "the workspace itself is fine",
  )
  assert.equal(
    shouldBlockWorktreePath({ targetPath: "/repo/.slate/worktrees/app/other", workspacePaths: ["/repo/src"] }),
    false,
    "the guard only applies when every workspace path is a worktree",
  )
})

test("the platform's managed files are recognized by shape", () => {
  const base = "/home/u/.slate/projects/ws1"
  assert.equal(isAgentTranscriptPath(`${base}/agent-transcripts/session.json`), true)
  assert.equal(isAgentTranscriptPath(`${base}/other/session.json`), false)
  assert.equal(isTerminalsDirectory(`${base}/terminals`), true)
  assert.equal(isTerminalsDirectory(`${base}/terminals/1.txt`), false)
  assert.deepEqual(extractTerminalId(`${base}/terminals/12.txt`), { id: 12 })
  assert.equal(extractTerminalId(`${base}/terminals/abc.txt`), null)
  assert.equal(isAgentToolOutputFile(`${base}/agent-tools/out.txt`), true)
  assert.equal(isAgentToolOutputFile(`${base}/agent-tools/out.log`), false)
  assert.equal(sanitizeFilename("a b/c.txt"), "a_b_c.txt")
  assert.equal(canonicalizeWorkspacePath("a/./b/../c"), "a/c")
  assert.equal(canonicalizeWorkspacePath("a\\b/./c/../d"), "a/b/d")
  assert.equal(isWorkspaceCanvasDocument(`${base}/canvases/board.canvas.tsx`), true)
  assert.equal(isWorkspaceCanvasDocument(`${base}/canvases/board.CANVAS.TSX`), true)
  assert.equal(isWorkspaceCanvasDocument(`${base}/canvases/board.tsx`), false)
  assert.equal(isWorkspaceCanvasDocument(`${base}/canvases/board.canvas.tsx/child`), false)
  assert.equal(isWorkspaceCanvasDocument(`${base}/canvases/../documents/board.canvas.tsx`), false)
})

test("a conversation id becomes a safe path component", () => {
  assert.equal(getSafeConversationId("abc-123"), "abc-123")
  assert.equal(getSafeConversationId("a/b").includes("/"), false)
  assert.equal(getSafeConversationId("../../etc/passwd").includes("/"), false, "a path component cannot escape its directory")
  assert.equal(getSafeConversationId("x".repeat(500)).length, MAX_CONVERSATION_ID_LENGTH)
})

test("command rules are normalized and refused when they are too broad", () => {
  assert.equal(normalizeAdminCommandDenylistText("  aws\u00a0:s3   rm  "), "aws :s3 rm")
  assert.deepEqual(parseAdminCommandDenylistColonRule("aws:*s3 rm*"), { executablePattern: "aws", argsPattern: "*s3 rm*" })
  assert.equal(parseAdminCommandDenylistColonRule(":rm"), undefined)

  assert.equal(getAdminCommandDenylistRuleError("aws s3 rm"), null)
  assert.match(getAdminCommandDenylistRuleError("   ") ?? "", /cannot be empty/)
  assert.match(getAdminCommandDenylistRuleError("*") ?? "", /every command/)
  assert.match(getAdminCommandDenylistRuleError(":rm") ?? "", /executable before/)
  assert.match(getAdminCommandDenylistRuleError("x".repeat(600)) ?? "", /cannot exceed/)

  assert.equal(commandMatchesPattern("git *", "git status"), true)
  assert.equal(commandMatchesPattern("git *", "git"), false)
  assert.equal(commandMatchesPattern("a.b", "a.b"), true)
  assert.equal(commandMatchesPattern("a.b", "axb"), false, "regex metacharacters match literally")
  assert.equal(commandMatchesPattern(" git * ", "git status"), true, "only pattern-edge whitespace is removed")
  assert.equal(commandMatchesPattern("git status", "git status "), false, "the command itself is compared exactly")
  assert.equal(commandMatchesPattern("", ""), true)
  assert.equal(commandMatchesPattern("*", ""), true)
  assert.equal(commandMatchesPattern("*", "line\nbreak"), false, "wildcards do not cross line breaks")
})

test("repository URLs are split the way each forge lays them out", () => {
  assert.equal(isGitHubDotComHost("github.com"), true)
  assert.equal(isGitHubDotComHost("gist.github.com"), true)
  assert.equal(isGitLabHost("gitlab.example.com"), true)
  assert.equal(isBitbucketCloudHost("bitbucket.org"), true)
  assert.equal(isAzureDevopsServicesHost("dev.azure.com"), true)

  assert.deepEqual(parseGitHubRepositoryPathSegments(["slate", "app.git", "tree"]), { owner: "slate", repo: "app", hasSubpath: true })
  assert.equal(parseGitHubRepositoryPathSegments(["only"]), undefined)
  assert.deepEqual(parseGitLabRepositoryPathSegments(["group", "sub", "project", "-", "issues"]), {
    repositorySegments: ["group", "sub", "project"],
    hasSpecialRouteSeparator: true,
  })
  assert.equal(parseGitLabRepositoryPathSegments(["single"]), undefined)
  assert.deepEqual(parseBitbucketRepositoryPathSegments(["workspace", "repo"]), { workspace: "workspace", repo: "repo", hasSubpath: false })
  assert.equal(parseBitbucketRepositoryPathSegments(["account", "repo"]), undefined)
  assert.deepEqual(parseAzureDevopsRepositoryPathSegments(["org", "project", "_git", "repo"]), {
    organization: "org",
    project: "project",
    repo: "repo",
    hasSubpath: false,
  })
  assert.deepEqual(parseAzureDevopsRepositoryPathSegments(["org", "_git", "repo", "extra"]), {
    organization: "org",
    project: "repo",
    repo: "repo",
    hasSubpath: true,
  })
  assert.equal(parseAzureDevopsRepositoryPathSegments(["org", "project", "repo"]), undefined)
})

test("image resizing keeps the aspect ratio inside the cap", () => {
  assert.deepEqual(targetDimensions(2000, 1000), { width: MAX_IMAGE_DIMENSION, height: 512, needsResize: true })
  assert.deepEqual(targetDimensions(1000, 2000), { width: 512, height: MAX_IMAGE_DIMENSION, needsResize: true })
  assert.deepEqual(targetDimensions(800, 600), { width: 800, height: 600, needsResize: false })
  assert.deepEqual(targetDimensions(1, 4000, 1024), { width: 1, height: 1024, needsResize: true })
})

test("an oversized image is resized to fit and stays decodable", async () => {
  const codecs = await getImageCodecs()
  const image = codecs.fromBitmap({ data: Buffer.alloc(2000 * 1200 * 4, 128), width: 2000, height: 1200 })
  const png = await image.getBuffer("image/png")
  const resized = await resizeImageBufferIfNeeded(Buffer.from(png))
  assert.equal(resized.mimeType, "image/png")
  const decoded = await codecs.read(Buffer.from(resized.data))
  assert.ok(decoded.width <= MAX_IMAGE_DIMENSION, `expected width <= ${MAX_IMAGE_DIMENSION}, got ${decoded.width}`)
  assert.ok(decoded.height <= MAX_IMAGE_DIMENSION)
  assert.ok(resized.data.length <= 1024 * 1024)
})

test("webp is recognized from its header, and needs a codec to decode", () => {
  const header = Buffer.alloc(30)
  header.write("RIFF", 0, "ascii")
  header.write("WEBP", 8, "ascii")
  header.write("VP8 ", 12, "ascii")
  header[23] = 157
  header[24] = 1
  header[25] = 42
  header.writeUInt16LE(640, 26)
  header.writeUInt16LE(480, 28)
  assert.equal(isWebp(header), true)
  assert.deepEqual(webpSize(header), { width: 640, height: 480 })
  assert.equal(webpSize(Buffer.from("not a webp")), undefined)
  assert.throws(() => decodeWebp(header), /not registered/)

  registerWebpCodec({
    decode: () => ({ data: new Uint8Array(4), width: 1, height: 1 }),
    encode: () => Buffer.from([1, 2, 3]),
  })
  assert.deepEqual(decodeWebp(header), { data: new Uint8Array(4), width: 1, height: 1 })
  assert.deepEqual(encodeWebp({ data: new Uint8Array(4), width: 1, height: 1 }), Buffer.from([1, 2, 3]))
  assert.equal(isWebp(header), true)
})

test("the platform's guidance strings are ours", () => {
  assert.equal(getIsoDateYearString("2026-09-25"), "2026")
  assert.throws(() => getIsoDateYearString("2026/09/25"), /Expected ISO date string/)
  const guidance = buildWebSearchYearGuidance("2026-09-25")
  assert.match(guidance, /Today's date is 2026-09-25/)
  assert.match(guidance, /React documentation 2026", NOT "React documentation 2025"/)

  assert.equal(shouldRebuildUserInfoForPullRequestRule({ renderedUserInfo: "<user_rule>Preferred pull request host:</user_rule>" }), true)
  assert.equal(shouldRebuildUserInfoForPullRequestRule({ renderedUserInfo: "<user_rule>Pull request forge (Creation Provider):</user_rule>" }), true)
  assert.equal(shouldRebuildUserInfoForPullRequestRule({ renderedUserInfo: "<user_rule>unrelated</user_rule>" }), false)
  assert.equal(shouldRebuildUserInfoForPullRequestRule({ selectedRule: "rule", renderedUserInfo: "<user_rule>rule</user_rule>" }), false)
  assert.equal(shouldRebuildUserInfoForPullRequestRule({ selectedRule: "rule", renderedUserInfo: "<user_rule>other</user_rule>" }), true)
  assert.equal(shouldRebuildUserInfoForPullRequestRule({ selectedRule: "", renderedUserInfo: "<user_rule>Preferred pull request host:</user_rule>" }), true)

  assert.equal(isLargeContextModel("dsv3-0324"), true)
  assert.equal(isLargeContextModel("kimi-k2p5-turbo"), true)
  assert.equal(isLargeContextModel("some-other-model"), false)
  assert.equal(isLargeContextModel(undefined), false)
})

test("sync work returns its value or captures whatever it threw", () => {
  assert.deepEqual(captureSync(() => 41 + 1), { ok: true, value: 42 })
  const failure = captureSync(() => { throw new Error("nope") })
  assert.equal(failure.ok, false)
  if (failure.ok) assert.fail("the throwing operation must be represented as a failure")
  assert.match((failure.error as Error).message, /nope/)
  assert.deepEqual(captureSync(() => { throw "plain failure" }), { ok: false, error: "plain failure" })
})
