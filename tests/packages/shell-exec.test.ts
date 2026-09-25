import { test } from "node:test"
import assert from "node:assert/strict"
import fs from "node:fs"
import os from "node:os"
import path from "node:path"

import {
  SUDO_ALIAS,
  getSudoAliasInjection,
  shouldEnableSudoAskpass,
  transformSudoCommand,
} from "../../source/packages/shell-exec/sudo.ts"
import {
  SOCKET_ENV_VARS_TO_SCRUB,
  filterElectronEnv,
  scrubSocketEnvVars,
} from "../../source/packages/shell-exec/env-filter.ts"
import { attachShellOutputStreams } from "../../source/packages/shell-exec/output-limiter.ts"
import { getSandboxCacheEnv } from "../../source/packages/shell-exec/sandbox/cache-env.ts"
import {
  ensureSandboxPolicyDirectory,
  writeSandboxPolicyFile,
} from "../../source/packages/shell-exec/sandbox/policy-file.ts"
import {
  getEffectiveNetworkPolicy,
  isNetworkEnabledByPolicy,
  networkAllowAllPolicy,
  networkDisabledPolicy,
} from "../../source/packages/shell-exec/sandbox/network-policy-utils.ts"
import { SandboxUnsupportedError } from "../../source/packages/shell-exec/sandbox/errors.ts"
import {
  getGitWriteProtectionMapping,
  getHardcodedAllowedReadPaths,
  getHardcodedSandboxPolicy,
  getWorktreeWriteProtectionMapping,
  convertPathsToIgnoreMapping,
} from "../../source/packages/shell-exec/sandbox/hardcoded-policy.ts"
import { SHELL_ENV_OVERRIDES, KnownShellExecutor } from "../../source/packages/shell-exec/types.ts"
import { SHELL_OUTPUT_SUPPRESSION_DEFAULTS, SHELL_OUTPUT_SUPPRESSED_NOTICE } from "../../source/packages/shell-exec/output-suppression.ts"
import { EventLoopPressureThresholdDefault, EventLoopPressureTrackerDefault } from "../../source/packages/shell-exec/event-loop-pressure.ts"
import { getRipgrepBinaryPath, withConfiguredRipgrepEnv } from "../../source/packages/shell-exec/ripgrep.ts"
import { windowsPathToGitBash, getZshPath } from "../../source/packages/shell-exec/platform-shell.ts"
import { spawnUnsafe } from "../../source/packages/shell-exec/sandbox/unsafe-spawn.ts"

// ---------------------------------------------------------------------------------------------
// rewriting a command so sudo does not stop to ask
// ---------------------------------------------------------------------------------------------

test("a sudo that starts a command is given the askpass flag", () => {
  assert.equal(transformSudoCommand("sudo apt-get install curl"), "sudo -A apt-get install curl")
  assert.equal(transformSudoCommand("cd /tmp && sudo rm -rf x"), "cd /tmp && sudo rm -rf x".replace("sudo rm", "sudo -A rm"))
  assert.equal(transformSudoCommand("a | sudo tee f"), "a | sudo -A tee f")
  assert.equal(transformSudoCommand("a; sudo ls"), "a; sudo -A ls")
  assert.equal(transformSudoCommand("a || sudo ls"), "a || sudo -A ls")
})

test("a sudo that already asks is left alone", () => {
  assert.equal(transformSudoCommand("sudo -A ls"), "sudo -A ls")
  assert.equal(transformSudoCommand("sudo -nA ls"), "sudo -nA ls")
})

test("a word that merely starts with sudo is not a sudo", () => {
  assert.equal(transformSudoCommand("sudoku --help"), "sudoku --help")
  assert.equal(transformSudoCommand("echo sudoers"), "echo sudoers")
})

test("a sudo that is not at a command position is left alone", () => {
  assert.equal(transformSudoCommand("echo 'sudo ls'"), "echo 'sudo ls'")
  assert.equal(transformSudoCommand("printf sudo"), "printf sudo")
})

test("the alias is injected only where sudo could ask for a password", () => {
  assert.equal(shouldEnableSudoAskpass({ SUDO_ASKPASS: "/usr/bin/askpass" }), process.platform !== "win32")
  assert.equal(shouldEnableSudoAskpass({}), false)
  assert.equal(getSudoAliasInjection({ SUDO_ASKPASS: "/usr/bin/askpass" }), process.platform === "win32" ? "" : `${SUDO_ALIAS}; `)
  assert.equal(getSudoAliasInjection({}), "")
})

// ---------------------------------------------------------------------------------------------
// the environment a command is given
// ---------------------------------------------------------------------------------------------

test("the flag that would turn the process into a node is removed", () => {
  const filtered = filterElectronEnv({ ELECTRON_RUN_AS_NODE: "1", KEEP: "yes" })
  assert.deepEqual(filtered, { KEEP: "yes" })
})

test("the session's own sockets are removed from the environment", () => {
  const env = { SSH_AUTH_SOCK: "/tmp/agent", KEEP: "yes" }
  assert.deepEqual(scrubSocketEnvVars(env), { KEEP: "yes" })
  assert.equal(SOCKET_ENV_VARS_TO_SCRUB.includes("SSH_AUTH_SOCK"), true)
  // The original is not changed.
  assert.equal(env.SSH_AUTH_SOCK, "/tmp/agent")
})

test("a command is told it is not running in a terminal", () => {
  assert.equal(SHELL_ENV_OVERRIDES.TERM, "dumb")
  assert.equal(SHELL_ENV_OVERRIDES.NO_COLOR, "1")
  assert.equal(SHELL_ENV_OVERRIDES.FORCE_COLOR, "0")
})

// ---------------------------------------------------------------------------------------------
// moving output
// ---------------------------------------------------------------------------------------------

/** A stream that hands the test's chunks to whoever is reading it. */
function readable(chunks: readonly Buffer[]) {
  const listeners: Array<(data: Buffer) => void> = []
  return {
    on(_event: "data", listener: (data: Buffer) => void) { listeners.push(listener) },
    async *[Symbol.asyncIterator]() { for (const chunk of chunks) yield chunk },
    emit() { for (const listener of listeners) for (const chunk of chunks) listener(chunk) },
  }
}

const collector = () => {
  const written: Array<{ type: string; data: Buffer }> = []
  return { written, writable: { async write(event: { type: string; data: Buffer }) { written.push(event) } } }
}

test("chunks of the same stream that arrive together are written as one", async () => {
  const { written, writable } = collector()
  const streams = attachShellOutputStreams({
    stdout: readable([Buffer.from("a"), Buffer.from("b")]),
    writable,
    bufferOutputEvents: true,
  })
  await streams.waitForOutput()
  await streams.flush()
  assert.deepEqual(written.map(event => [event.type, event.data.toString()]), [["stdout", "ab"]])
})

test("two streams keep the order they arrived in, and are not joined across the change", async () => {
  const { written, writable } = collector()
  const streams = attachShellOutputStreams({
    stdout: readable([Buffer.from("out")]),
    stderr: readable([Buffer.from("err")]),
    writable,
    bufferOutputEvents: true,
  })
  await streams.waitForOutput()
  await streams.flush()
  // Both were written, and no write mixes the two streams.
  assert.deepEqual(written.map(event => event.type).sort(), ["stderr", "stdout"])
  assert.equal(written.every(event => event.type === "stdout" ? event.data.toString() === "out" : event.data.toString() === "err"), true)
})

test("without buffering every chunk is written as it arrives", async () => {
  const { written, writable } = collector()
  const stdout = readable([Buffer.from("a"), Buffer.from("b")])
  attachShellOutputStreams({ stdout, writable, bufferOutputEvents: false })
  stdout.emit()
  assert.deepEqual(written.map(event => event.data.toString()), ["a", "b"])
})

test("an empty chunk is not worth a write", async () => {
  const { written, writable } = collector()
  const streams = attachShellOutputStreams({
    stdout: readable([Buffer.alloc(0)]),
    writable,
    bufferOutputEvents: true,
  })
  await streams.waitForOutput()
  await streams.flush()
  assert.deepEqual(written, [])
})

test("a write that fails does not fail the command", async () => {
  const streams = attachShellOutputStreams({
    stdout: readable([Buffer.from("a")]),
    writable: { async write() { throw new Error("the reader is gone") } },
    bufferOutputEvents: true,
  })
  await streams.waitForOutput()
  await streams.flush()
})

test("a command's output is not streamed faster than it is worth watching", () => {
  assert.equal(SHELL_OUTPUT_SUPPRESSION_DEFAULTS.windowMs, 60_000)
  // More is allowed while the loop is under pressure, which is when streaming costs the most.
  assert.equal(SHELL_OUTPUT_SUPPRESSION_DEFAULTS.thresholdCharsPerSecondWithoutPressure > SHELL_OUTPUT_SUPPRESSION_DEFAULTS.minimumThresholdCharsPerSecond, true)
  assert.match(SHELL_OUTPUT_SUPPRESSED_NOTICE, /still run/)
})

test("the pressure thresholds are the ones the tracker samples at", () => {
  assert.equal(EventLoopPressureThresholdDefault.EventLoopDelayP95Ms, 50)
  assert.equal(EventLoopPressureTrackerDefault.SampleIntervalMs, 250)
  assert.equal(EventLoopPressureTrackerDefault.EventLoopResolutionMs, 20)
})

// ---------------------------------------------------------------------------------------------
// the sandbox's own bookkeeping
// ---------------------------------------------------------------------------------------------

test("a network policy that was not given denies", () => {
  assert.deepEqual(getEffectiveNetworkPolicy(undefined), { version: 1, default: "deny" })
  assert.equal(isNetworkEnabledByPolicy(undefined), false)
  assert.equal(isNetworkEnabledByPolicy(networkDisabledPolicy()), false)
  assert.equal(isNetworkEnabledByPolicy(networkAllowAllPolicy()), true)
  assert.equal(isNetworkEnabledByPolicy({ version: 1, default: "deny", allow: ["example.com"] }), true)
})

test("an unsupported sandbox says what was unsupported", () => {
  const error = new SandboxUnsupportedError("no sandbox here", "seatbelt")
  assert.equal(error.name, "SandboxUnsupportedError")
  assert.equal(error.reason, "seatbelt")
  assert.equal(new SandboxUnsupportedError("no sandbox here").reason, undefined)
})

test("the policy directory is private and its files are written private", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "slate-sandbox-policy-"))
  const previous = process.env.SLATE_SANDBOX_POLICY_DIR
  process.env.SLATE_SANDBOX_POLICY_DIR = dir
  try {
    const ensured = ensureSandboxPolicyDirectory()
    assert.equal(ensured, path.resolve(dir))
    const file = writeSandboxPolicyFile('{"version":1}')
    assert.equal(path.dirname(file), ensured)
    assert.equal(fs.readFileSync(file, "utf8"), '{"version":1}')
    // The file is named after a random suffix, so two writes do not collide.
    assert.notEqual(writeSandboxPolicyFile("{}"), file)
    assert.equal((fs.statSync(file).mode & 0o777), 0o600)
  } finally {
    if (previous === undefined) delete process.env.SLATE_SANDBOX_POLICY_DIR
    else process.env.SLATE_SANDBOX_POLICY_DIR = previous
    fs.rmSync(dir, { recursive: true, force: true })
  }
})

test("a policy file that is no longer used is swept", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "slate-sandbox-policy-"))
  const previous = process.env.SLATE_SANDBOX_POLICY_DIR
  process.env.SLATE_SANDBOX_POLICY_DIR = dir
  try {
    const stale = path.join(dir, "sandbox-policy-old")
    fs.writeFileSync(stale, "{}")
    // An hour and a minute ago is older than the sweep keeps.
    const old = new Date(Date.now() - 61 * 60 * 1_000)
    fs.utimesSync(stale, old, old)
    const kept = path.join(dir, "not-a-policy")
    fs.writeFileSync(kept, "{}")
    ensureSandboxPolicyDirectory()
    assert.equal(fs.existsSync(stale), false)
    assert.equal(fs.existsSync(kept), true)
  } finally {
    if (previous === undefined) delete process.env.SLATE_SANDBOX_POLICY_DIR
    else process.env.SLATE_SANDBOX_POLICY_DIR = previous
    fs.rmSync(dir, { recursive: true, force: true })
  }
})

test("the caches a command writes are pointed somewhere disposable", () => {
  const env = getSandboxCacheEnv()
  assert.equal(env.NPM_CONFIG_CACHE.startsWith(os.tmpdir()), true)
  assert.equal(env.CARGO_TARGET_DIR.startsWith(os.tmpdir()), true)
  // The toolchain's own home is not redirected, since it holds executables rather than caches.
  assert.equal("CARGO_HOME" in env, false)
  assert.equal("RUSTUP_HOME" in env, false)
  assert.equal("GEM_HOME" in env, false)
})

// ---------------------------------------------------------------------------------------------
// what the sandbox starts from
// ---------------------------------------------------------------------------------------------

test("the read paths are the ones this platform has", () => {
  const paths = getHardcodedAllowedReadPaths(process.platform, os.homedir(), {})
  assert.equal(paths.includes("/bin"), process.platform !== "win32")
  // A bundled path that is not installed is not allowed, since a policy naming a missing file fails.
  assert.equal(getHardcodedAllowedReadPaths("darwin", "/home/someone", {}).some(entry => entry.includes("ripgrep")), false)
  // A home path is only allowed when it is actually a file.
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "slate-home-"))
  try {
    fs.writeFileSync(path.join(home, ".bashrc"), "")
    assert.equal(getHardcodedAllowedReadPaths("darwin", home, {}).includes(path.join(home, ".bashrc")), true)
    assert.equal(getHardcodedAllowedReadPaths("darwin", home, {}).includes(path.join(home, ".zshrc")), false)
  } finally {
    fs.rmSync(home, { recursive: true, force: true })
  }
})

test("paths become an ignore mapping that says which are directories", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "slate-ignore-"))
  try {
    const file = path.join(dir, "a.txt")
    fs.writeFileSync(file, "")
    const mapping = convertPathsToIgnoreMapping(dir, file)
    // Both entries name the same directory, so they share one list: everything in it, and the file twice
    // so that neither the name nor anything under it is matched by accident.
    assert.deepEqual(mapping[dir], ["**", "a.txt", "a.txt/**"])
  } finally {
    fs.rmSync(dir, { recursive: true, force: true })
  }
})

test("the write protection covers what would outlive the command", () => {
  const policy = getHardcodedSandboxPolicy("/repo")
  assert.equal(policy.type, "workspace_readwrite")
  assert.equal(policy.networkPolicyStrict, true)
  // A repository's own editor configuration and a virtual environment are protected by the workspace rules;
  // the parts of a repository that change what it is are protected by the git rules, which are separate.
  assert.equal(policy.writeProtectionMapping["/repo"]?.some(pattern => pattern.includes(".vscode/")), true)
  assert.equal(policy.writeProtectionMapping["/repo"]?.some(pattern => pattern.includes(".venv/")), true)
  assert.equal(policy.writeProtectionMapping["/repo"]?.some(pattern => pattern.includes(".git/")), false)
  // The platform's own directories are the exception: they are written by the platform itself.
  assert.equal(policy.writeProtectionMapping["/repo"]?.some(pattern => pattern.startsWith("!")), true)
})

test("the git and worktree protections are the ones that belong to each", () => {
  const git = getGitWriteProtectionMapping("/repo/.git")
  assert.equal(git["/repo/.git"]?.every(pattern => pattern.includes(".git/")), true)
  const worktree = getWorktreeWriteProtectionMapping("/repo")
  assert.deepEqual(worktree["/repo"], [".git"])
})

test("a sandbox's own directories are not written by a command", () => {
  const policy = getHardcodedSandboxPolicy("/repo")
  // The policy files live in the user's own directory, and a command must not be able to rewrite them.
  assert.equal(policy.additionalReadonlyPaths.some(entry => entry.endsWith("sandbox-policies")), true)
})

// ---------------------------------------------------------------------------------------------
// the shells themselves
// ---------------------------------------------------------------------------------------------

test("a shell is named for the implementation that drives it", () => {
  assert.equal(KnownShellExecutor.Zsh, "zsh")
  assert.equal(KnownShellExecutor.ZshLight, "zsh-light")
  assert.equal(KnownShellExecutor.Bash, "bash")
  assert.equal(KnownShellExecutor.PowerShell, "powershell")
  assert.equal(KnownShellExecutor.Naive, "naive")
})

test("the search binary is only redirected once it is configured", () => {
  const env = { PATH: "/usr/bin" }
  // Nothing is configured in a test process, so the environment is handed back as it was.
  assert.equal(withConfiguredRipgrepEnv(env), env)
  assert.throws(() => getRipgrepBinaryPath(), /not configured/)
})

test("a path is only translated for Git Bash on Windows", () => {
  // On every other platform a path is already the path a command uses.
  assert.equal(windowsPathToGitBash("/tmp/a b"), "/tmp/a b")
})

test("the zsh this machine has is found", () => {
  const zsh = getZshPath()
  assert.equal(typeof zsh, "string")
  assert.equal(zsh.length > 0, true)
})

test("the sandbox can be skipped only by asking for it explicitly", async () => {
  const child = spawnUnsafe(process.execPath, ["-e", "process.exit(0)"])
  const code = await new Promise<number | null>((resolve) => child.on("exit", resolve))
  assert.equal(code, 0)
})
