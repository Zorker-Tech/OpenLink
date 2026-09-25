import { test } from "node:test"
import assert from "node:assert/strict"
import { devNull } from "node:os"
import { mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import path from "node:path"

import { redactHttpUrlUserinfo } from "../../source/packages/git-core/url-redaction.ts"
import { appendGitDiagnostics } from "../../source/packages/git-core/error-diagnostics.ts"
import { createGitProcessEnv } from "../../source/packages/git-core/process-env.ts"
import { gitExecFile } from "../../source/packages/git-core/git-exec.ts"

// ---------------------------------------------------------------------------------------------
// git-core: credentials never leave in a URL
// ---------------------------------------------------------------------------------------------

test("userinfo is stripped from an http url", () => {
  assert.equal(redactHttpUrlUserinfo("https://user:token@host.example/repo.git"), "https://host.example/repo.git")
  assert.equal(redactHttpUrlUserinfo("http://user@host.example/repo"), "http://host.example/repo")
})

test("a url with no userinfo, and one with no scheme, are left alone", () => {
  assert.equal(redactHttpUrlUserinfo("https://host.example/repo.git"), "https://host.example/repo.git")
  assert.equal(redactHttpUrlUserinfo("git@host.example:repo.git"), "git@host.example:repo.git")
  assert.equal(redactHttpUrlUserinfo("no url here"), "no url here")
})

test("the query and fragment go with the userinfo, because a token hides there too", () => {
  assert.equal(
    redactHttpUrlUserinfo("https://user:token@host.example/repo?access_token=abc#main"),
    "https://host.example/repo",
  )
})

test("punctuation around a url stays outside it", () => {
  assert.equal(redactHttpUrlUserinfo("(see https://user:token@host.example/repo)."), "(see https://host.example/repo).")
  assert.equal(redactHttpUrlUserinfo("<https://user:token@host.example/repo>"), "<https://host.example/repo>")
})

test("every url in a line is rewritten", () => {
  assert.equal(
    redactHttpUrlUserinfo("https://a:b@one.example/x and https://c:d@two.example/y"),
    "https://one.example/x and https://two.example/y",
  )
})

test("an at sign that is part of the path is not treated as userinfo", () => {
  assert.equal(redactHttpUrlUserinfo("https://host.example/a@b"), "https://host.example/a@b")
})

test("a url inside a larger message keeps the rest of the message", () => {
  assert.equal(
    redactHttpUrlUserinfo("fatal: could not read from https://user:secret@host.example/repo.git"),
    "fatal: could not read from https://host.example/repo.git",
  )
})

// ---------------------------------------------------------------------------------------------
// git-core: what a git failure adds to its message
// ---------------------------------------------------------------------------------------------

test("a git error contributes its code and exit code in one suffix", () => {
  const error = Object.assign(new Error("command failed"), { gitErrorCode: "ENOREPO", exitCode: 128 })
  assert.equal(appendGitDiagnostics("command failed", error), "command failed [git: gitErrorCode=ENOREPO exitCode=128]")
})

test("only the parts a git error actually has are reported", () => {
  assert.equal(appendGitDiagnostics("failed", { exitCode: 1 }), "failed [git: exitCode=1]")
  assert.equal(appendGitDiagnostics("failed", { gitErrorCode: "EAUTH" }), "failed [git: gitErrorCode=EAUTH]")
  assert.equal(appendGitDiagnostics("failed", {}), "failed")
  assert.equal(appendGitDiagnostics("failed", new Error("plain")), "failed")
  assert.equal(appendGitDiagnostics("failed", null), "failed")
  assert.equal(appendGitDiagnostics("failed", "a string"), "failed")
})

test("an already annotated message is not annotated twice", () => {
  const error = Object.assign(new Error("x"), { exitCode: 1 })
  const once = appendGitDiagnostics("failed", error)
  assert.equal(appendGitDiagnostics(once, error), once)
})

test("a non-finite exit code is not reported", () => {
  assert.equal(appendGitDiagnostics("failed", { exitCode: Number.NaN }), "failed")
  assert.equal(appendGitDiagnostics("failed", { gitErrorCode: "" }), "failed")
})

test("stderr is added only when asked for, and comes with credentials removed", () => {
  const error = Object.assign(new Error("failed"), {
    exitCode: 128,
    stderr: "fatal: could not read from https://user:secret@host.example/repo.git\n",
  })
  const without = appendGitDiagnostics("failed", error)
  assert.doesNotMatch(without, /git stderr/)
  assert.doesNotMatch(without, /secret/)

  const withStderr = appendGitDiagnostics("failed", error, { includeStderr: true })
  assert.match(withStderr, /\[git: exitCode=128\]\n--- git stderr ---\nfatal: could not read from https:\/\/host\.example\/repo\.git/)
  assert.doesNotMatch(withStderr, /secret/)
})

test("a long stderr is capped and says it was capped", () => {
  const stderr = "x".repeat(3_000)
  const annotated = appendGitDiagnostics("failed", { exitCode: 1, stderr }, { includeStderr: true })
  assert.match(annotated, /\[truncated to 2048 chars\]$/)
  assert.equal(annotated.length < stderr.length + 100, true)
})

// ---------------------------------------------------------------------------------------------
// git-core: the environment git is run in
// ---------------------------------------------------------------------------------------------

test("the dangerous settings are pinned even when nothing configured them", () => {
  const env = createGitProcessEnv({})
  assert.equal(env.GIT_CONFIG_COUNT, "4")
  const entries = new Map<string, string>()
  for (let index = 0; index < 4; index++) {
    entries.set(String(env[`GIT_CONFIG_KEY_${index}`]), String(env[`GIT_CONFIG_VALUE_${index}`]))
  }
  assert.equal(entries.get("safe.bareRepository"), "explicit")
  assert.equal(entries.get("core.fsmonitor"), "false")
  assert.equal(entries.get("core.hooksPath"), devNull)
  assert.equal(entries.get("core.attributesFile"), devNull)
})

test("an entry that already names a pinned key is rewritten rather than duplicated", () => {
  const env = createGitProcessEnv({
    spawnerEnv: {
      GIT_CONFIG_COUNT: "2",
      GIT_CONFIG_KEY_0: "core.hooksPath",
      GIT_CONFIG_VALUE_0: "/tmp/evil-hooks",
      GIT_CONFIG_KEY_1: "user.name",
      GIT_CONFIG_VALUE_1: "someone",
    },
  })
  // The rewritten entry keeps its index; the three keys it did not name are appended after it.
  assert.equal(env.GIT_CONFIG_COUNT, "5")
  assert.equal(env.GIT_CONFIG_KEY_0, "core.hooksPath")
  assert.equal(env.GIT_CONFIG_VALUE_0, devNull)
  assert.equal(env.GIT_CONFIG_KEY_1, "user.name")
  assert.equal(env.GIT_CONFIG_VALUE_1, "someone")
  const pinnedValues = [0, 1, 2, 3, 4].map(index => env[`GIT_CONFIG_VALUE_${index}`])
  assert.equal(pinnedValues.filter(value => value === devNull).length, 2)
})

test("a count that is missing or nonsense is treated as no entries", () => {
  for (const count of [undefined, "", "abc", "-1"]) {
    const env = createGitProcessEnv({ spawnerEnv: { GIT_CONFIG_COUNT: count } })
    assert.equal(env.GIT_CONFIG_COUNT, "4", String(count))
    assert.equal(env.GIT_CONFIG_KEY_0, "safe.bareRepository")
  }
})

test("the locale and the pager are pinned so git's output parses", () => {
  const env = createGitProcessEnv({ spawnerEnv: { LC_ALL: "tr_TR.UTF-8", GIT_PAGER: "less" } })
  assert.equal(env.LC_ALL, "en_US.UTF-8")
  assert.equal(env.LANG, "en_US.UTF-8")
  assert.equal(env.GIT_PAGER, "cat")
})

test("a caller's own environment wins over the process's, and loses to nothing", () => {
  const env = createGitProcessEnv({
    spawnerEnv: { CUSTOM_FROM_SPAWNER: "spawner", SHARED: "spawner" },
    optionsEnv: { CUSTOM_FROM_OPTIONS: "options", SHARED: "options" },
  })
  assert.equal(env.CUSTOM_FROM_SPAWNER, "spawner")
  assert.equal(env.CUSTOM_FROM_OPTIONS, "options")
  assert.equal(env.SHARED, "options")
})

test("the invoking command is passed under our own variable, and removed when there is none", () => {
  assert.equal(createGitProcessEnv({ command: "status" }).SLATE_GIT_COMMAND, "status")
  assert.equal(createGitProcessEnv({}).SLATE_GIT_COMMAND, undefined)
  const cleared = createGitProcessEnv({ spawnerEnv: { SLATE_GIT_COMMAND: "leftover" } })
  assert.equal(cleared.SLATE_GIT_COMMAND, undefined)
})

// ---------------------------------------------------------------------------------------------
// git-core: running git
// ---------------------------------------------------------------------------------------------

test("a git command runs and its output comes back as text", async () => {
  const result = await gitExecFile("git", ["--version"])
  assert.match(result.stdout, /^git version /)
  assert.equal(result.stderr, "")
})

test("the environment reaches git itself: the pinned hook path is what git reports", async () => {
  const result = await gitExecFile("git", ["config", "--get", "core.hooksPath"])
  assert.equal(result.stdout.trim(), devNull)
})

test("a failing git command rejects with what git said", async () => {
  const directory = await mkdtemp(path.join(tmpdir(), "slate-git-core-"))
  try {
    await assert.rejects(
      gitExecFile("git", ["rev-parse", "--show-toplevel"], { cwd: directory }),
      (error: unknown) => {
        assert.ok(error instanceof Error)
        assert.match(String((error as { stderr?: unknown }).stderr), /not a git repository/)
        return true
      },
    )
  } finally {
    await rm(directory, { recursive: true, force: true })
  }
})

test("the subcommand is found past the options that take a value", async () => {
  // `-c` and `-C` consume the next argument, so the command is the one after them.
  const result = await gitExecFile("git", ["-c", "core.pager=cat", "--version"])
  assert.match(result.stdout, /^git version /)
})
