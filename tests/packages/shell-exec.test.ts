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
import { analyzeShellCommand } from "../../source/packages/shell-exec/shell-parser.ts"
import { withPolicyDirectoryReadonly, withSandboxPolicyDirectoryReadonly } from "../../source/packages/shell-exec/sandbox/policy-readonly.ts"
import {
  buildSandboxArgv,
  buildSandboxChildEnvironment,
  buildSandboxPolicyEnvelope,
  projectSandboxCommand,
} from "../../source/packages/shell-exec/sandbox/helper-protocol.ts"
import { buildNativeSandboxPolicy } from "../../source/packages/shell-exec/sandbox/native-policy.ts"
import { getSandboxPolicyType, resolveSandboxPolicyForWorkspace } from "../../source/packages/shell-exec/sandbox/policy-merge.ts"
import {
  getLastSandboxFailureReason,
  isSandboxHelperSupported,
  spawnWithSandboxHelper,
  spawnWithSandboxHelperPolicy,
} from "../../source/packages/shell-exec/sandbox/helper-support.ts"

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

// ---------------------------------------------------------------------------------------------
// reading a command
// ---------------------------------------------------------------------------------------------

test("a command's words and arguments are read out of it", () => {
  const result = analyzeShellCommand("git commit -m 'a message'")
  assert.equal(result.structured.parsingFailed, false)
  assert.deepEqual(result.structured.executableCommands.map(command => command.name), ["git"])
  assert.deepEqual(result.structured.executableCommands[0]?.args.map(arg => arg.value), ["commit", "-m", "'a message'"])
  assert.equal(result.structured.executableCommands[0]?.fullText, "git commit -m 'a message'")
  assert.deepEqual(result.legacy.simpleCommands, ["git"])
})

test("every command in a chain is read, not only the first", () => {
  const result = analyzeShellCommand("git status && npm test | tee out")
  assert.deepEqual(result.structured.executableCommands.map(command => command.name), ["git", "npm", "tee"])
  assert.deepEqual(result.legacy.simpleCommands, ["git", "npm", "tee"])
})

test("a substitution is marked as one, and the command inside it is read", () => {
  const result = analyzeShellCommand("echo $(ls -la)")
  assert.equal(result.structured.hasCommandSubstitution, true)
  assert.deepEqual(result.structured.executableCommands.map(command => command.name), ["echo", "ls"])
})

test("a redirect to the null device is safe to allow", () => {
  const result = analyzeShellCommand("ls -la > /dev/null")
  assert.equal(result.structured.hasRedirects, true)
  assert.equal(result.structured.allRedirectsAreDevNull, true)
  assert.deepEqual(result.structured.redirects[0], { operator: ">", destinationFds: [1], targetNodeType: "word", targetText: "/dev/null" })
})

test("a redirect to a file is not safe to allow", () => {
  const result = analyzeShellCommand("ls -la > out.txt")
  assert.equal(result.structured.allRedirectsAreDevNull, false)
  assert.equal(result.structured.redirects[0]?.targetText, "out.txt")
})

test("redirecting a stream into another stream is safe only when the source is", () => {
  // Standard error into standard output is the stream the command was given.
  assert.equal(analyzeShellCommand("ls 2>&1").structured.allRedirectsAreDevNull, true)
  // A stream that was already redirected to a file is not.
  assert.equal(analyzeShellCommand("ls 2> out.txt 1>&2").structured.allRedirectsAreDevNull, false)
})

test("reading a file in is a redirect the caller has to decide about", () => {
  const result = analyzeShellCommand("sort < in.txt")
  assert.equal(result.structured.allRedirectsAreDevNull, false)
  assert.equal(result.legacy.hasInputRedirect, true)
})

test("a heredoc is a redirect whose receiver is known", () => {
  const result = analyzeShellCommand("cat <<EOF\nhello\nEOF")
  assert.equal(result.structured.hasRedirects, true)
  assert.equal(result.structured.allRedirectsAreDevNull, true)
  assert.equal(result.structured.redirects[0]?.targetText, "cat")
  assert.equal(result.legacy.hasInputRedirect, true)
})

test("a heredoc inside a substitution is not the receiver's own", () => {
  const result = analyzeShellCommand("echo $(cat <<EOF\nhello\nEOF\n)")
  assert.equal(result.structured.allRedirectsAreDevNull, false)
})

test("a redirect whose shape is not recognized is not safe", () => {
  const result = analyzeShellCommand("ls &> /dev/null")
  // Both streams go to the null device, which is safe.
  assert.equal(result.structured.allRedirectsAreDevNull, true)
  assert.deepEqual(analyzeShellCommand("ls > /dev/null > out.txt").structured.allRedirectsAreDevNull, false)
})

test("the older shape says whether anything was redirected at all", () => {
  const plain = analyzeShellCommand("ls -la")
  assert.deepEqual(plain.legacy, { simpleCommands: ["ls"], hasInputRedirect: false, hasOutputRedirect: false })
  const redirected = analyzeShellCommand("ls > /dev/null")
  assert.equal(redirected.legacy.hasOutputRedirect, true)
})

// ---------------------------------------------------------------------------------------------
// the policy a sandbox is given
// ---------------------------------------------------------------------------------------------

test("the policy directory is made read-only in every policy", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "slate-policy-readonly-"))
  const previous = process.env.SLATE_SANDBOX_POLICY_DIR
  process.env.SLATE_SANDBOX_POLICY_DIR = dir
  try {
    const policyDirectory = ensureSandboxPolicyDirectory()
    assert.deepEqual(withPolicyDirectoryReadonly(), [policyDirectory])
    assert.deepEqual(withPolicyDirectoryReadonly(["/etc"]), ["/etc", policyDirectory])
    // A list that already names it is not given it twice.
    assert.deepEqual(withPolicyDirectoryReadonly([policyDirectory]), [policyDirectory])
    const input = { type: "workspace_readwrite" as const, additionalReadonlyPaths: ["/etc"] }
    const policy = withSandboxPolicyDirectoryReadonly(input)
    assert.deepEqual(policy.additionalReadonlyPaths, ["/etc", policyDirectory])
    assert.equal(policy.type, "workspace_readwrite")
  } finally {
    if (previous === undefined) delete process.env.SLATE_SANDBOX_POLICY_DIR
    else process.env.SLATE_SANDBOX_POLICY_DIR = previous
    fs.rmSync(dir, { recursive: true, force: true })
  }
})

test("the sandbox is told which command to run and where its policy is", () => {
  assert.deepEqual(buildSandboxArgv("/tmp/policy", "ls", ["-la"]), ["--policy", "/tmp/policy", "--", "ls", "-la"])
})

test("a command run through a shell is projected into one", () => {
  // Without a shell the command is run as the program it is.
  assert.deepEqual(projectSandboxCommand("ls", ["-la"], false), { command: "ls", args: ["-la"] })
  const throughShell = projectSandboxCommand("ls", ["-la"], true)
  assert.equal(throughShell.args[0], "-c")
  assert.equal(throughShell.args[1], "ls -la")
})

test("the environment a sandboxed command is given says it is sandboxed", () => {
  const env = buildSandboxChildEnvironment({ KEEP: "yes" })
  assert.equal(env.SLATE_SANDBOX, "native")
  assert.equal(env.KEEP, "yes")
})

test("a network policy the helper cannot act on is left out of the envelope", () => {
  const denied = buildSandboxPolicyEnvelope({ type: "workspace_readwrite" }, {
    type: "workspace_readwrite",
    networkPolicy: { version: 1, default: "deny" },
  })
  assert.equal(denied.networkPolicy, undefined)
  const allowed = buildSandboxPolicyEnvelope({ type: "workspace_readwrite" }, {
    type: "workspace_readwrite",
    networkPolicy: { version: 1, default: "allow", deny: ["example.com"] },
  })
  assert.deepEqual(allowed.networkPolicy, { version: 1, default: "allow", deny: ["example.com"] })
})

test("a policy that is not sandboxed is not given a network policy at all", () => {
  const envelope = buildSandboxPolicyEnvelope({ type: "insecure_none" }, {
    type: "insecure_none",
    networkPolicy: { version: 1, default: "allow" },
  })
  assert.equal(envelope.networkPolicy, undefined)
  assert.deepEqual(envelope.sandbox, { type: "insecure_none" })
})

test("the policy a sandbox runs under is resolved from what the caller asked for", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "slate-native-policy-"))
  try {
    const policy = buildNativeSandboxPolicy({ type: "workspace_readwrite" }, dir)
    assert.equal(policy.type, "workspace_readwrite")
    assert.equal(policy.cwd, dir)
    assert.equal(policy.readBoundary, "system")
    // The system's own paths are readable, and a readwrite policy may also write its workspace.
    assert.equal(policy.hardcodedReadPaths.length > 0, true)
    assert.deepEqual(policy.additionalReadwritePaths, [])
    assert.equal(policy.disableTmpWrite, false)
    assert.equal(policy.networkAccess, false)
  } finally {
    fs.rmSync(dir, { recursive: true, force: true })
  }
})

test("a read-only policy is not given anywhere to write", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "slate-native-policy-"))
  try {
    const policy = buildNativeSandboxPolicy({ type: "workspace_readonly" }, dir)
    assert.equal("additionalReadwritePaths" in policy, false)
    assert.equal("disableTmpWrite" in policy, false)
  } finally {
    fs.rmSync(dir, { recursive: true, force: true })
  }
})

test("a policy confined to its workspace trusts only the roots it was given", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "slate-native-policy-"))
  try {
    const policy = buildNativeSandboxPolicy({ type: "workspace_readwrite", readBoundary: "workspace", additionalReadPaths: ["/srv/data", "/srv/data/**"] }, dir)
    assert.equal(policy.readBoundary, "workspace")
    // The glob is reduced to the directory it was anchored at, and named once.
    assert.equal(policy.hardcodedReadPaths.includes("/srv/data"), true)
    assert.equal(policy.hardcodedReadPaths.filter(entry => entry === "/srv/data").length, 1)
  } finally {
    fs.rmSync(dir, { recursive: true, force: true })
  }
})

test("a write protection mapping is written under both the path and what it resolves to", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "slate-native-policy-"))
  const link = `${dir}-link`
  try {
    fs.symlinkSync(dir, link)
    const policy = buildNativeSandboxPolicy({
      type: "workspace_readwrite",
      writeProtectionMapping: { [link]: ["**/.git/**"] },
    }, dir)
    assert.deepEqual(policy.additionalReadonlyPaths?.[link], ["**/.git/**"])
    // The same mapping is also under the canonical path, so a command reaching it either way is covered —
    // and the canonical path is what the filesystem says it is, which may differ from the path given.
    assert.deepEqual(policy.additionalReadonlyPaths?.[fs.realpathSync(dir)], ["**/.git/**"])
  } finally {
    fs.rmSync(dir, { recursive: true, force: true })
    fs.rmSync(link, { recursive: true, force: true })
  }
})

test("a policy that allows the network says so", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "slate-native-policy-"))
  try {
    const policy = buildNativeSandboxPolicy({ type: "workspace_readwrite", networkPolicy: networkAllowAllPolicy() }, dir)
    assert.equal(policy.networkAccess, true)
  } finally {
    fs.rmSync(dir, { recursive: true, force: true })
  }
})

// ---------------------------------------------------------------------------------------------
// one policy from several
// ---------------------------------------------------------------------------------------------

const policyDir = () => fs.mkdtempSync(path.join(os.tmpdir(), "slate-policy-merge-"))

test("a workspace with no policies at all is not sandboxed", async () => {
  const dir = policyDir()
  try {
    const { policy } = await resolveSandboxPolicyForWorkspace(dir, undefined)
    assert.deepEqual(policy, { type: "insecure_none" })
  } finally {
    fs.rmSync(dir, { recursive: true, force: true })
  }
})

test("the strictest source decides whether there is a sandbox at all", () => {
  assert.equal(getSandboxPolicyType({}), "insecure_none")
  assert.equal(getSandboxPolicyType({ perUser: { type: "workspace_readonly" } }), "workspace_readonly")
  // The organization speaks last, then the repository, then the person.
  assert.equal(getSandboxPolicyType({
    perUser: { type: "insecure_none" },
    perRepo: { type: "workspace_readonly" },
    teamAdmin: { type: "workspace_readwrite" },
  }), "workspace_readwrite")
})

test("sources that disagree about the kind of sandbox are not a policy", async () => {
  const dir = policyDir()
  try {
    await assert.rejects(
      () => resolveSandboxPolicyForWorkspace(dir, { perUser: { type: "workspace_readwrite" }, perRepo: { type: "insecure_none" } }),
      /Cannot merge policies of different types/,
    )
  } finally {
    fs.rmSync(dir, { recursive: true, force: true })
  }
})

test("what may be written is the union of what each source allowed", async () => {
  const dir = policyDir()
  try {
    const { policy } = await resolveSandboxPolicyForWorkspace(dir, {
      perUser: { type: "workspace_readwrite", additionalReadwritePaths: ["/a"] },
      perRepo: { type: "workspace_readwrite", additionalReadwritePaths: ["/b"] },
    })
    assert.deepEqual((policy.additionalReadwritePaths as string[]).sort(), ["/a", "/b"])
  } finally {
    fs.rmSync(dir, { recursive: true, force: true })
  }
})

test("a policy that may not write is not given anywhere to write", async () => {
  const dir = policyDir()
  try {
    const { policy } = await resolveSandboxPolicyForWorkspace(dir, {
      perRepo: { type: "workspace_readonly", additionalReadwritePaths: ["/a"] },
    })
    assert.equal(policy.type, "workspace_readonly")
    assert.equal("additionalReadwritePaths" in policy, false)
  } finally {
    fs.rmSync(dir, { recursive: true, force: true })
  }
})

test("the read boundary is the strictest one named", async () => {
  const dir = policyDir()
  try {
    const confined = await resolveSandboxPolicyForWorkspace(dir, {
      perUser: { type: "workspace_readwrite", readBoundary: "system" },
      perRepo: { type: "workspace_readwrite", readBoundary: "workspace", additionalReadPaths: ["/srv", "/var"] },
    })
    assert.equal(confined.policy.readBoundary, "workspace")
    // Only the paths the confining source named are readable, and only while it is the boundary.
    assert.deepEqual(confined.policy.additionalReadPaths, ["/srv", "/var"])
    const open = await resolveSandboxPolicyForWorkspace(dir, {
      perRepo: { type: "workspace_readwrite", readBoundary: "workspace", additionalReadPaths: ["/srv"] },
      teamAdmin: { type: "workspace_readwrite", readBoundary: "system" },
    })
    // The boundary is still the strictest, so the paths are still the ones that came with it.
    assert.equal(open.policy.readBoundary, "workspace")
    assert.deepEqual(open.policy.additionalReadPaths, ["/srv"])
  } finally {
    fs.rmSync(dir, { recursive: true, force: true })
  }
})

test("what is read-only is everything anyone said was", async () => {
  const dir = policyDir()
  try {
    const { policy } = await resolveSandboxPolicyForWorkspace(dir, {
      perUser: { type: "workspace_readwrite", additionalReadonlyPaths: ["/secrets"] },
      perRepo: { type: "workspace_readwrite", additionalReadonlyPaths: ["/etc/ssl"] },
    })
    const readonly = policy.additionalReadonlyPaths as string[]
    assert.equal(readonly.includes("/secrets"), true)
    assert.equal(readonly.includes("/etc/ssl"), true)
    // The platform's own protections are in there as well, since a policy is never less than the baseline.
    assert.equal(readonly.some(entry => entry.endsWith("sandbox-policies")), true)
  } finally {
    fs.rmSync(dir, { recursive: true, force: true })
  }
})

test("a boolean that tightens the sandbox is true if anyone said so", async () => {
  const dir = policyDir()
  try {
    const { policy } = await resolveSandboxPolicyForWorkspace(dir, {
      perRepo: { type: "workspace_readwrite", disableTmpWrite: true },
    })
    assert.equal(policy.disableTmpWrite, true)
    assert.equal(policy.networkPolicyStrict, true)
  } finally {
    fs.rmSync(dir, { recursive: true, force: true })
  }
})

test("a choice rather than a restriction comes from the highest priority source", async () => {
  const dir = policyDir()
  try {
    const { policy } = await resolveSandboxPolicyForWorkspace(dir, {
      perUser: { type: "workspace_readwrite", debugOutputDir: "/user", enableSharedBuildCache: false },
      perRepo: { type: "workspace_readwrite", debugOutputDir: "/repo" },
      teamAdmin: { type: "workspace_readwrite", debugOutputDir: "/org" },
    })
    assert.equal(policy.debugOutputDir, "/org")
    assert.equal(policy.enableSharedBuildCache, false)
  } finally {
    fs.rmSync(dir, { recursive: true, force: true })
  }
})

test("a network policy denies if anyone denied, and allows what anyone allowed", async () => {
  const dir = policyDir()
  try {
    const { policy } = await resolveSandboxPolicyForWorkspace(dir, {
      perUser: { type: "workspace_readwrite", networkPolicy: { version: 1, default: "allow", allow: ["a.example"], deny: ["bad.example"] } },
      perRepo: { type: "workspace_readwrite", networkPolicy: { version: 1, default: "allow", allow: ["b.example"] } },
    })
    const network = policy.networkPolicy as { default: string; allow: string[]; deny: string[] }
    // Nobody denied by default, so the default stays what it was; the deny list is still the union.
    assert.equal(network.default, "allow")
    assert.deepEqual([...network.allow].sort(), ["a.example", "b.example"])
    assert.deepEqual(network.deny, ["bad.example"])
  } finally {
    fs.rmSync(dir, { recursive: true, force: true })
  }
})

test("the organization's allowlist replaces what the others allowed", async () => {
  const dir = policyDir()
  try {
    const { policy } = await resolveSandboxPolicyForWorkspace(dir, {
      perUser: { type: "workspace_readwrite", networkPolicy: { version: 1, default: "allow", allow: ["mine.example"] } },
      teamAdmin: { type: "workspace_readwrite", networkPolicy: { version: 1, default: "allow", allow: ["org.example"] } },
    })
    assert.deepEqual((policy.networkPolicy as { allow: string[] }).allow, ["org.example"])
  } finally {
    fs.rmSync(dir, { recursive: true, force: true })
  }
})

test("a policy that names nothing about the network denies it", async () => {
  const dir = policyDir()
  try {
    const { policy } = await resolveSandboxPolicyForWorkspace(dir, { perRepo: { type: "workspace_readwrite" } })
    assert.deepEqual(policy.networkPolicy, { version: 1, default: "deny" })
  } finally {
    fs.rmSync(dir, { recursive: true, force: true })
  }
})

test("a policy denies the network by default when a source says so", async () => {
  const dir = policyDir()
  try {
    const { policy } = await resolveSandboxPolicyForWorkspace(dir, {
      perUser: { type: "workspace_readwrite", networkPolicy: { version: 1, default: "allow" } },
      perRepo: { type: "workspace_readwrite", networkPolicy: { version: 1, default: "deny" } },
    })
    assert.equal((policy.networkPolicy as { default: string }).default, "deny")
  } finally {
    fs.rmSync(dir, { recursive: true, force: true })
  }
})

test("a policy that is not sandboxed still merges what it was told", async () => {
  const dir = policyDir()
  try {
    const { policy } = await resolveSandboxPolicyForWorkspace(dir, {
      perUser: { type: "insecure_none", captureDenies: true, enableSharedBuildCache: true },
    })
    assert.equal(policy.type, "insecure_none")
    assert.equal(policy.captureDenies, true)
    assert.equal(policy.enableSharedBuildCache, true)
    // Nothing else is carried, since a policy that does not sandbox has nothing to configure.
    assert.equal("writeProtectionMapping" in policy, false)
  } finally {
    fs.rmSync(dir, { recursive: true, force: true })
  }
})

// ---------------------------------------------------------------------------------------------
// the sandbox helper
// ---------------------------------------------------------------------------------------------

test("the sandbox is reported as unsupported when no helper is configured", () => {
  // Nothing is configured in a test process, and the answer is remembered rather than probed again.
  assert.equal(isSandboxHelperSupported(), false)
  assert.match(getLastSandboxFailureReason() ?? "", /not configured/)
})

test("a spawn is refused before anything is run when there is no helper", () => {
  // The helper is looked for before the policy is read, so a spawn without one is refused whatever the
  // policy says rather than quietly running the command unsandboxed.
  assert.throws(
    () => spawnWithSandboxHelper(process.execPath, ["-e", "process.exit(0)"], {}, { type: "insecure_none" }),
    /Sandbox binary not available/,
  )
})

test("a command that is sandboxed is refused when there is no helper to run it", () => {
  assert.throws(
    () => spawnWithSandboxHelper(process.execPath, [], {}, { type: "workspace_readwrite" }),
    /Sandbox binary not available/,
  )
})

test("a policy the helper cannot run is refused rather than run without a sandbox", () => {
  assert.throws(
    () => spawnWithSandboxHelperPolicy(process.execPath, [], {}, { type: "insecure_none" } as never),
    /Expected workspace_readwrite or workspace_readonly policy/,
  )
})
