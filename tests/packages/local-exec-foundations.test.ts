import { test } from "node:test"
import assert from "node:assert/strict"
import fs from "node:fs"
import os from "node:os"
import path from "node:path"

import { clampInt32, toOptionalDurationMsInt32 } from "../../source/packages/local-exec/int32.ts"
import { parseIgnoreRules } from "../../source/packages/local-exec/ignore-rules.ts"
import { isPathPatternRepoUrl, isWildcardRepoUrl } from "../../source/packages/local-exec/team-repo-filters.ts"
import { toHostPath } from "../../source/packages/local-exec/git-repo-identity.ts"
import { resolvePathForIgnoreService } from "../../source/packages/local-exec/ignore-path.ts"
import { sanitizeServerName } from "../../source/packages/local-exec/mcp.ts"
import { DEFAULT_SHELL_FOREGROUND_TIMEOUT_MS, resolveShellTimeoutMs } from "../../source/packages/local-exec/shell-timeout.ts"
import { MAX_TOOL_ANNOTATION_TITLE_LENGTH, toolAnnotationsJsonField } from "../../source/packages/local-exec/mcp-tool-annotations.ts"
import { sanitizeToolCallId, validateAndNormalizeSaveAsFilename } from "../../source/packages/local-exec/record-screen-paths.ts"
import { PointScaler } from "../../source/packages/local-exec/computer-use/scaling.ts"
import { exec } from "../../source/packages/local-exec/computer-use/shell.ts"
import { LocalLsExecutor, MissingLsTraversalBindingError } from "../../source/packages/local-exec/ls.ts"
import { forcedShellSandboxPolicy, isForcedShellEgressEnabled } from "../../source/packages/local-exec/forced-egress.ts"
import { getModelShellAdminCommandDenylistBlockReason } from "../../source/packages/local-exec/services/admin-command-denylist.ts"
import { convertInternalToProtoPolicy, convertProtoToInternalPolicy } from "../../source/packages/local-exec/sandbox-conversion.ts"
import { DEFAULT_AGENT_DATA_CLEANUP_INTERVAL_MS, DEFAULT_AGENT_DATA_TTL_MS } from "../../source/packages/local-exec/agent-data-cleanup.ts"
import { MAX_BUFFER_SIZE, MAX_OFS_FILE_SIZE } from "../../source/packages/local-exec/constants.ts"
import { PI_DEFAULT_MAX_BYTES } from "../../source/packages/local-exec/pi/truncate.ts"
import { OperationType } from "../../source/packages/local-exec/pending-decision-provider.ts"
import { CLOUD_SPECIFIC_INSTRUCTIONS_HEADER, CLOUD_SPECIFIC_INSTRUCTIONS_SEPARATOR } from "../../source/packages/local-exec/services/cloud-rules-service.ts"
import { SLATE_PROJECTS_ROOT, SLATE_WORKTREES_ROOT } from "../../source/packages/local-exec/internal-paths.ts"
import { isRipgrepInvocationRecordingEnabled, recordRipgrepInvocation } from "../../source/packages/local-exec/ripgrep-invocation-recorder.ts"
import { createContext } from "../../source/packages/context/context.ts"
import { RequestedFilePathRejectedReason } from "../../source/packages/proto/generated/agent/v1/record_screen_exec_pb.ts"
import {
  NetworkPolicy as NetworkPolicyProto,
  NetworkPolicy_DefaultAction,
  SandboxPolicy,
  SandboxPolicy_Type,
} from "../../source/packages/proto/generated/agent/v1/sandbox_pb.ts"

// ---------------------------------------------------------------------------------------------
// Numbers and names the executor works with
// ---------------------------------------------------------------------------------------------

test("a duration that does not fit in 32 bits is clamped rather than wrapped", () => {
  assert.equal(clampInt32(Number.NaN), 0)
  assert.equal(clampInt32(2 ** 31 - 1), 2 ** 31 - 1)
  assert.equal(clampInt32(2 ** 31), 2 ** 31 - 1)
  assert.equal(clampInt32(-(2 ** 31)), -(2 ** 31))
  assert.equal(clampInt32(-(2 ** 31) - 1), -(2 ** 31))
  // A duration that was not given is nothing, not a zero-length one.
  assert.equal(toOptionalDurationMsInt32(-1), undefined)
  assert.equal(toOptionalDurationMsInt32("5"), undefined)
  assert.equal(toOptionalDurationMsInt32(Number.POSITIVE_INFINITY), undefined)
  assert.equal(toOptionalDurationMsInt32(1.9), 1)
})

test("an ignore file is read as the patterns it holds, in order", () => {
  const rules = parseIgnoreRules("# a comment\n\n  build/\r\ndist/**\n")
  assert.deepEqual(rules, ["build/", "dist/**"])
  assert.deepEqual(parseIgnoreRules(""), [])
})

test("a repository setting is a URL, a pattern, or every repository", () => {
  assert.equal(isWildcardRepoUrl("  *  "), true)
  assert.equal(isWildcardRepoUrl("github.com/a/b"), false)
  assert.equal(isPathPatternRepoUrl("src/**"), true)
  assert.equal(isPathPatternRepoUrl("https://github.com/a/b"), false)
  assert.equal(isPathPatternRepoUrl("git@github.com:a/b.git"), false)
  assert.equal(isPathPatternRepoUrl("gitlab.com/a/b"), false)

  assert.equal(isWildcardRepoUrl("*"), true)
  assert.equal(isWildcardRepoUrl("**"), false, "two stars are a pattern, not the wildcard")
  assert.equal(isWildcardRepoUrl(""), false)
  assert.equal(isWildcardRepoUrl(" *x "), false)
  assert.equal(isPathPatternRepoUrl(""), true, "a setting with nothing URL-shaped in it is a pattern")
  assert.equal(isPathPatternRepoUrl("GitHub.com/a/b"), true, "the host markers are compared as they are written")
  assert.equal(isPathPatternRepoUrl("github.com.evil/x"), false, "a marker inside a longer host still counts")
  assert.equal(isPathPatternRepoUrl("@"), false)
  assert.equal(isPathPatternRepoUrl("://"), false)
  assert.equal(isPathPatternRepoUrl("bitbucket.org/a/b"), false)
  assert.equal(isPathPatternRepoUrl("example.com/a/b"), true)
  assert.equal(isPathPatternRepoUrl("user/repo"), true)
  assert.equal(isPathPatternRepoUrl("*"), true, "the wildcard is a pattern too")
})

test("the same repository is one identity however it was reached", () => {
  assert.equal(toHostPath("git@github.com:acme/widgets.git"), "github.com/acme/widgets")
  assert.equal(toHostPath("https://github.com/acme/widgets/"), "github.com/acme/widgets")
  assert.equal(toHostPath("ssh://git@github.com/acme/widgets.git"), "github.com/acme/widgets")
  assert.equal(toHostPath("github.com/acme/widgets?ref=main"), "github.com/acme/widgets")
})

test("only an absolute path that resolves is a path the ignore service is asked about", async () => {
  assert.equal(await resolvePathForIgnoreService("relative/path"), null)
  // A path that does not exist yet still resolves — the part of it that exists is real, and the rest is kept.
  assert.equal(await resolvePathForIgnoreService("/no/such/path/anywhere"), "/no/such/path/anywhere")

  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "slate-ignore-"))
  const link = `${dir}-link`
  try {
    fs.symlinkSync(dir, link)
    assert.equal(await resolvePathForIgnoreService(link), fs.realpathSync(dir))
  } finally {
    fs.rmSync(link, { force: true })
    fs.rmSync(dir, { recursive: true, force: true })
  }
})

test("a server's name is reduced to one token", () => {
  assert.equal(sanitizeServerName("my server"), "my_server")
  assert.equal(sanitizeServerName("a/b:c"), "abc")
  assert.equal(sanitizeServerName("a..b"), "a.b")
  assert.equal(sanitizeServerName("."), "_")
  assert.equal(sanitizeServerName(".."), "_")
  assert.equal(sanitizeServerName(""), "_")

  assert.equal(sanitizeServerName("..."), "_", "a run of dots is a dot-path too")
  assert.equal(sanitizeServerName("a...b"), "a.b", "a run of dots collapses to one")
  assert.equal(sanitizeServerName("a..b..c"), "a.b.c", "every run of dots collapses, not just the first")
  assert.equal(sanitizeServerName("..a"), ".a")
  assert.equal(sanitizeServerName("a."), "a.")
  assert.equal(sanitizeServerName("a  b"), "a__b", "every whitespace character becomes its own underscore")
  assert.equal(sanitizeServerName("a\tb\nc"), "a_b_c")
  assert.equal(sanitizeServerName("a\u00a0b"), "a_b", "a non-breaking space is whitespace too")
  assert.equal(sanitizeServerName("üa"), "a", "characters the registry cannot hold are dropped")
  assert.equal(sanitizeServerName("文件"), "_")
  assert.equal(sanitizeServerName("a-b_c.d"), "a-b_c.d", "letters, digits, underscore, dot and dash are kept")
  assert.equal(sanitizeServerName("  "), "__")
})

// ---------------------------------------------------------------------------------------------
// Timeouts, annotations and names the surfaces are given
// ---------------------------------------------------------------------------------------------

test("a timeout of zero is only allowed where there is something else to stop the command", () => {
  assert.equal(resolveShellTimeoutMs({ timeout: 5_000, isBackground: false }), 5_000)
  assert.equal(resolveShellTimeoutMs({ timeout: 0, isBackground: false }), DEFAULT_SHELL_FOREGROUND_TIMEOUT_MS)
  assert.equal(resolveShellTimeoutMs({ timeout: 0, isBackground: true }), 0)
  assert.equal(resolveShellTimeoutMs({ timeout: 0, isBackground: false, hardTimeout: 1_000 }), 0)
})

test("tool annotations are bounded to what the wire holds", () => {
  const long = "x".repeat(MAX_TOOL_ANNOTATION_TITLE_LENGTH + 50)
  const json = toolAnnotationsJsonField({ title: long, readOnlyHint: true, destructiveHint: "yes" as never, extra: 1 })
  const parsed = JSON.parse(json.annotationsJson!) as Record<string, unknown>
  assert.equal((parsed.title as string).length, MAX_TOOL_ANNOTATION_TITLE_LENGTH)
  assert.equal(parsed.readOnlyHint, true)
  assert.equal("destructiveHint" in parsed, false)
  // A tool that said nothing carries no annotations at all.
  assert.deepEqual(toolAnnotationsJsonField(undefined), {})
  assert.deepEqual(toolAnnotationsJsonField({}), {})
})

test("a recording's file name is taken relative to the artifacts directory and kept usable", () => {
  assert.equal(sanitizeToolCallId("call/1:x"), "call_1_x")

  const dir = "/artifacts"
  assert.deepEqual(validateAndNormalizeSaveAsFilename("/artifacts/demo.mp4", dir), { success: true, filename: "demo.mp4" })
  // An extension the recording does not have is replaced by the one it does.
  assert.deepEqual(validateAndNormalizeSaveAsFilename("demo.mov", dir), { success: true, filename: "demo.mov.mp4" })
  assert.deepEqual(validateAndNormalizeSaveAsFilename("  ", dir), { success: false, reason: RequestedFilePathRejectedReason.UNSPECIFIED })
  // A name that tries to leave the directory is refused rather than written elsewhere.
  assert.deepEqual(validateAndNormalizeSaveAsFilename("../outside.mp4", dir), {
    success: false,
    reason: RequestedFilePathRejectedReason.SLASHES_NOT_ALLOWED,
  })
})

test("coordinates are scaled between the display and the API, and a mismatch is refused", () => {
  const scaler = new PointScaler({ display: { width: 1_000, height: 500 }, api: { width: 2_000, height: 1_000 } })
  assert.deepEqual(scaler.toDisplay(100, 50), { x: 50, y: 25 })
  assert.deepEqual(scaler.toApi(50, 25), { x: 100, y: 50 })
  assert.equal(scaler.apiWidth, 2_000)
  assert.equal(scaler.displayHeight, 500)
  assert.throws(
    () => new PointScaler({ display: { width: 1_000, height: 500 }, api: { width: 1_000, height: 900 } }),
    /Aspect ratio mismatch/,
  )
})

test("a command run for the computer-use surface reports its output and its failures", async () => {
  assert.equal(await exec("/bin/sh", ["-c", "printf hi"]), "hi")
  await assert.rejects(() => exec("/bin/sh", ["-c", "exit 3"]))
  await assert.rejects(() => exec("/bin/sh", ["-c", "sleep 5"], { timeoutMs: 50 }))
})

test("a command's arguments are text, its environment is the caller's laid over this process's, and its output is the stdout text", async () => {
  assert.equal(await exec("/bin/echo", [42]), "42\n", "a number argument is run as its text")
  assert.equal(await exec("/bin/sh", ["-c", "printf '%s' \"$1\"", "sh", "a b"]), "a b", "an argument with a space stays one argument")
  assert.equal(await exec("/bin/echo", ["ünïcode"]), "ünïcode\n")
  assert.equal(await exec("/bin/sh", ["-c", "printf out; printf err >&2"]), "out", "the error text is not the answer")
  assert.equal(await exec("/bin/sh", ["-c", "printf zero"], { timeoutMs: 0 }), "zero", "a zero timeout is no timeout")
  assert.equal(await exec("/bin/sh", ["-c", "sleep 0.2; printf slow"]), "slow", "the default timeout leaves room for a slow command")

  const inherited = process.env.SLATE_PROBE_INHERITED
  const shadow = process.env.SLATE_PROBE_SHADOW
  process.env.SLATE_PROBE_INHERITED = "inherited"
  process.env.SLATE_PROBE_SHADOW = "process"
  try {
    assert.equal(await exec("/bin/sh", ["-c", "printf %s \"$SLATE_PROBE_INHERITED\""]), "inherited")
    assert.equal(
      await exec("/bin/sh", ["-c", "printf %s \"$SLATE_PROBE_INHERITED:$SLATE_PROBE_EXTRA\""], { env: { SLATE_PROBE_EXTRA: "extra" } }),
      "inherited:extra",
      "the caller's environment is laid over this process's own",
    )
    assert.equal(await exec("/bin/sh", ["-c", "printf %s \"$SLATE_PROBE_SHADOW\""], { env: { SLATE_PROBE_SHADOW: "caller" } }), "caller")
  } finally {
    if (inherited === undefined) delete process.env.SLATE_PROBE_INHERITED
    else process.env.SLATE_PROBE_INHERITED = inherited
    if (shadow === undefined) delete process.env.SLATE_PROBE_SHADOW
    else process.env.SLATE_PROBE_SHADOW = shadow
  }
})

test("a command that could kill itself is refused as a rejected promise with the code and the signal", async () => {
  await assert.rejects(() => exec("/bin/sh", ["-c", "exit 3"]), (error: unknown) => (error as { code?: unknown }).code === 3)
  await assert.rejects(
    () => exec("/bin/sh", ["-c", "sleep 5"], { timeoutMs: 50 }),
    (error: unknown) => (error as { killed?: unknown }).killed === true && (error as { signal?: unknown }).signal === "SIGTERM",
  )
  await assert.rejects(() => exec("/nonexistent-slate-probe", []), (error: unknown) => (error as { code?: unknown }).code === "ENOENT")
  const refusing = exec(123 as unknown as string, [])
  assert.equal(refusing instanceof Promise, true, "a refusal is a rejected promise, not a throw")
  await assert.rejects(refusing, TypeError)
})

// ---------------------------------------------------------------------------------------------
// Listing a directory
// ---------------------------------------------------------------------------------------------

const ignoreService = {
  listCursorIgnoreFilesByRoot: async () => [],
  getRepoBlockExcludeGlobs: async () => [],
  isRepoBlocked: () => false,
}

function traversalOf(lines: readonly string[], didTimeout = false) {
  return {
    walk: () => ({
      lines: (async function* () {
        yield* lines
      })(),
      didTimeout: Promise.resolve(didTimeout),
    }),
    resolveForIgnore: async (filePath: string) => filePath,
  }
}

function withTempDir(run: (dir: string) => Promise<void>) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "slate-ls-"))
  return run(dir).finally(() => fs.rmSync(dir, { recursive: true, force: true }))
}

test("a listing of something that is not there says so", async () => {
  await withTempDir(async (dir) => {
    const executor = new LocalLsExecutor(undefined, ignoreService, dir, traversalOf([]))
    const missing = await executor.execute(createContext(), { path: "nope" })
    assert.equal(missing.result.case, "error")
    assert.equal(missing.result.value?.error, `Path does not exist: ${path.join(dir, "nope")}`)

    const file = path.join(dir, "a.txt")
    fs.writeFileSync(file, "x")
    const notADirectory = await executor.execute(createContext(), { path: "a.txt" })
    assert.equal(notADirectory.result.case, "error")
    assert.match(notADirectory.result.value?.error ?? "", /Path is not a directory/)
  })
})

test("a listing without a traversal to run is an error of the platform", async () => {
  await withTempDir(async (dir) => {
    const executor = new LocalLsExecutor(undefined, ignoreService, dir)
    await assert.rejects(() => executor.execute(createContext(), { path: "." }), MissingLsTraversalBindingError)
  })
})

test("a listing nests what the traversal reports and counts it by extension", async () => {
  await withTempDir(async (dir) => {
    const executor = new LocalLsExecutor(undefined, ignoreService, dir, traversalOf(["src/a.ts", "src/b.ts", "docs/readme.md"]))
    const result = await executor.execute(createContext(), { path: "." })

    assert.equal(result.result.case, "success")
    const root = result.result.value?.directoryTreeRoot
    assert.deepEqual(root?.childrenDirs.map(node => path.basename(node.absPath)), ["docs", "src"])
    const src = root?.childrenDirs.find(node => path.basename(node.absPath) === "src")
    assert.deepEqual(src?.childrenFiles.map(file => file.name), ["a.ts", "b.ts"])
    const docs = root?.childrenDirs.find(node => path.basename(node.absPath) === "docs")
    assert.deepEqual(docs?.childrenFiles.map(file => file.name), ["readme.md"])
    assert.equal(root?.childrenWereProcessed, true)
  })
})

test("a listing that runs past its budget says it is not complete", async () => {
  await withTempDir(async (dir) => {
    const many = Array.from({ length: 400 }, (_, index) => `src/a-long-enough-file-name-${index}.ts`)
    const executor = new LocalLsExecutor(undefined, ignoreService, dir, traversalOf(many))
    const result = await executor.execute(createContext(), { path: "." })

    assert.equal(result.result.case, "success")
    const root = result.result.value?.directoryTreeRoot
    assert.equal(root?.childrenWereProcessed, false)
    // Files that arrived after the budget ran out are still counted, by extension, at every level above them.
    assert.equal((root?.fullSubtreeExtensionCounts[".ts"] ?? 0) > 0, true)
  })
})

test("a listing that ran out of time is reported as a timeout", async () => {
  await withTempDir(async (dir) => {
    const executor = new LocalLsExecutor(undefined, ignoreService, dir, traversalOf(["src/a.ts"], true))
    const result = await executor.execute(createContext(), { path: "." })
    assert.equal(result.result.case, "timeout")
  })
})

// ---------------------------------------------------------------------------------------------
// Egress and the commands an administrator forbade
// ---------------------------------------------------------------------------------------------

// The egress rules are read from the environment once, so they are set before anything asks for them.
process.env.SLATE_FORCED_SHELL_EGRESS = "1"
process.env.SLATE_FORCED_SHELL_EGRESS_DEPENDENCY_REGEX = "^npm(?:\\s|$)|^pnpm(?:\\s|$)"
process.env.SLATE_FORCED_SHELL_EGRESS_SOURCE_REGEX = "^git$"
process.env.SLATE_FORCED_SHELL_EGRESS_WRITABLE_PATHS = "/tmp:relative-is-dropped"

test("a command that is only a dependency install gets the egress it needs", () => {
  assert.equal(isForcedShellEgressEnabled(), true)
  const policy = forcedShellSandboxPolicy("npm install", { executableCommands: [{ name: "npm", fullText: "npm install" }] })

  assert.equal(policy.networkPolicy.default, "allow")
  // Nothing is left to the defaults, and the cache the install needs is shared.
  assert.equal(policy.skipStatsigDefaults, true)
  assert.equal(policy.enableSharedBuildCache, true)
  assert.deepEqual(policy.additionalReadwritePaths, ["/tmp"])
})

test("a command whose egress cannot be predicted gets no egress at all", () => {
  const command = { executableCommands: [{ name: "npm", fullText: "npm install" }] }
  const loopback = (policy: ReturnType<typeof forcedShellSandboxPolicy>) => {
    assert.equal(policy.networkPolicy.default, "deny")
    assert.equal(policy.networkPolicyStrict, true)
    assert.deepEqual(policy.networkPolicy.allow, ["127.0.0.0/8", "::1/128", "localhost"])
  }

  // A substitution can reach the network in a way the parser did not see.
  loopback(forcedShellSandboxPolicy("npm install $(curl example.com)", command))
  // So can a command that chains — the operator is in the text the parser reported — and one the parser could
  // not read at all.
  loopback(forcedShellSandboxPolicy("npm install && curl example.com", {
    executableCommands: [{ name: "npm", fullText: "npm install && curl example.com" }],
  }))
  loopback(forcedShellSandboxPolicy("npm install", { parsingFailed: true }))
  loopback(forcedShellSandboxPolicy("npm install", undefined))
  // And a command that is not the kind the rules describe keeps the loopback policy too.
  loopback(forcedShellSandboxPolicy("curl example.com", { executableCommands: [{ name: "curl", fullText: "curl example.com" }] }))
})

test("an administrator's denylist blocks a command written any way, and fails closed", () => {
  const rule = "npm:install *"
  const blocked = ["npm", "npm install left-pad"]
  const reason = getModelShellAdminCommandDenylistBlockReason({
    command: "npm install left-pad",
    parsingResult: { parsingFailed: false, executableCommands: [{ fullText: "npm install left-pad" }] },
    blockedCommands: [rule],
  })
  assert.match(reason ?? "", /denylist rule:/)
  assert.match(reason ?? "", /was not executed/)

  // A command that could not be analyzed is blocked rather than allowed through.
  const unanalyzable = getModelShellAdminCommandDenylistBlockReason({
    command: "npm install",
    parsingResult: { parsingFailed: true, executableCommands: [] },
    blockedCommands: blocked,
  })
  assert.match(unanalyzable ?? "", /could not be conclusively analyzed/)

  // Nothing forbidden means nothing to say, and a rule that does not match does not block.
  assert.equal(getModelShellAdminCommandDenylistBlockReason({
    command: "npm install",
    parsingResult: { parsingFailed: false, executableCommands: [{ fullText: "npm install" }] },
    blockedCommands: [],
  }), undefined)
  assert.equal(getModelShellAdminCommandDenylistBlockReason({
    command: "git status",
    parsingResult: { parsingFailed: false, executableCommands: [{ fullText: "git status" }] },
    blockedCommands: [rule],
  }), undefined)
})

// ---------------------------------------------------------------------------------------------
// A policy on both sides of the wire
// ---------------------------------------------------------------------------------------------

test("a sandbox policy survives the trip to the wire and back", () => {
  const proto = new SandboxPolicy({
    type: SandboxPolicy_Type.WORKSPACE_READWRITE,
    additionalReadwritePaths: ["/tmp/build"],
    additionalReadonlyPaths: ["/opt/sdk"],
    disableTmpWrite: true,
    networkPolicy: new NetworkPolicyProto({
      version: 1,
      defaultAction: NetworkPolicy_DefaultAction.DENY,
      allow: ["registry.npmjs.org"],
    }),
  })

  const internal = convertProtoToInternalPolicy(proto)
  assert.equal(internal.type, "workspace_readwrite")
  assert.deepEqual(internal.additionalReadwritePaths, ["/tmp/build"])
  assert.equal(internal.networkPolicy?.default, "deny")
  assert.deepEqual(internal.networkPolicy?.allow, ["registry.npmjs.org"])

  // What comes back is the same policy, which is what makes the trip safe to take twice.
  assert.deepEqual(convertProtoToInternalPolicy(convertInternalToProtoPolicy(internal)), internal)
})

test("a policy that is not there stays absent rather than becoming an empty one", () => {
  assert.deepEqual(convertProtoToInternalPolicy(undefined), { type: "insecure_none" })
  assert.equal(convertInternalToProtoPolicy(undefined), undefined)
})

// ---------------------------------------------------------------------------------------------
// The numbers and names the executor keeps
// ---------------------------------------------------------------------------------------------

test("the executor's own constants are the ones it promises", () => {
  assert.equal(DEFAULT_AGENT_DATA_TTL_MS, 30 * 24 * 60 * 60 * 1_000)
  assert.equal(DEFAULT_AGENT_DATA_CLEANUP_INTERVAL_MS, 24 * 60 * 60 * 1_000)
  assert.equal(MAX_BUFFER_SIZE, 1_048_576)
  assert.equal(MAX_OFS_FILE_SIZE, 50 * 1024 * 1024)
  assert.equal(PI_DEFAULT_MAX_BYTES, 50 * 1024)
  assert.equal(OperationType.Write, "write")
  assert.equal(OperationType.Shell, "shell")
  assert.equal(OperationType.Delete, "delete")
  assert.equal(OperationType.Mcp, "mcp")
  // The projects and worktrees the platform manages are its own directories.
  assert.equal(SLATE_PROJECTS_ROOT.endsWith(path.join(".slate", "projects")), true)
  assert.equal(SLATE_WORKTREES_ROOT.endsWith(path.join(".slate", "worktrees")), true)
  assert.equal(CLOUD_SPECIFIC_INSTRUCTIONS_SEPARATOR, `\n\n${CLOUD_SPECIFIC_INSTRUCTIONS_HEADER}\n`)
})

test("nothing is recorded about ripgrep until a caller asks to watch it", () => {
  assert.equal(isRipgrepInvocationRecordingEnabled(), false)
  // With no watcher installed, a recorded invocation is dropped rather than thrown.
  recordRipgrepInvocation({ args: ["--files"] })
  assert.equal(recordRipgrepInvocation({ args: [], cwd: "/tmp" }), undefined, "recording answers nothing")
  recordRipgrepInvocation(null as never)
  recordRipgrepInvocation(undefined as never)
  recordRipgrepInvocation(7 as never)
  assert.equal(isRipgrepInvocationRecordingEnabled(), false, "recording does not install a watcher")
})
