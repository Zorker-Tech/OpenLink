/**
 * Asking the sandbox helper to run a command, and whether it can.
 *
 * The sandbox is a separate program, so using it means answering two questions before running anything:
 * where the program is, and whether this machine can run it at all. The path is configuration rather than
 * something inferred, and it is looked for once and remembered — a machine that has the helper keeps it,
 * and one that does not is not asked again on every command. Whether it can run is a different question on
 * each platform: on macOS the system's own sandbox is always there, on Windows the helper only provides a
 * network proxy and no filesystem isolation, and on Linux it is not known until the helper has actually
 * started — so a preflight runs it against a policy that does nothing and a command that does nothing, and
 * an unsupported kernel is reported as such rather than discovered when a command fails.
 *
 * Running a command through the helper means writing the policy out and passing it, along with the command
 * and its arguments after a separator. A command that was to be run through a shell is projected into one
 * first, since the helper runs a program rather than a shell; the environment is filtered of what must not
 * travel and pointed at the configured search binary; and on macOS the child is registered with the time it
 * started and its process id, which is what makes its denials findable in the system log afterwards.
 *
 * A policy that says the command is not sandboxed is run directly rather than through the helper, and a
 * policy nobody recognizes is refused rather than run unsandboxed by accident.
 */

import { execFileSync, spawn, type ChildProcess, type SpawnOptions } from "node:child_process";
import { existsSync } from "node:fs";

import { createContext, type Context } from "../../context/index.ts";
import { createLogger } from "../../context/logging.ts";
import { filterElectronEnv, scrubSocketEnvVars } from "../env-filter.ts";
import { withConfiguredRipgrepEnv } from "../ripgrep.ts";
import { buildNativeSandboxPolicy, type NativeSandboxPolicyInput } from "./native-policy.ts";
import { resolveNetworkPolicyForFile, type HelperNetworkPolicy } from "./helper-protocol.ts";
import { registerSandboxMetadata } from "./macos/seatbelt.ts";
import { writeSandboxPolicyFile } from "./policy-file.ts";
import { withSandboxPolicyDirectoryReadonly } from "./policy-readonly.ts";

type PreflightInvocation = {
  readonly binaryPath: string;
  readonly args: readonly string[];
  readonly env: NodeJS.ProcessEnv;
};

type PreflightFailure = {
  message?: string;
  status?: number;
  stderrText?: string;
};

export type SandboxHelperPolicy = Omit<NativeSandboxPolicyInput, "networkPolicy"> & {
  readonly networkPolicy?: HelperNetworkPolicy;
  readonly networkPolicyStrict?: boolean;
  readonly sandboxWorkspaceRoot?: string;
  readonly enableSharedBuildCache?: boolean;
};

const logger = createLogger("shell-exec:sandbox");
const isMacOS = process.platform === "darwin";
const isLinux = process.platform === "linux";
const PREFLIGHT_PROBE_TIMEOUT_MS = 15_000;

// This binding is intentionally private and uninitialized. The shipped artifact
// receives no configured helper path in this reconstruction; no fallback path is
// inferred here.
let configuredSandboxBinaryPath: string | undefined;
let binaryAvailable: boolean | null = null;
let binaryCheckError: unknown = null;
let lastSandboxFailureReason: string | null = null;
let cachedSandboxHelperSupported: boolean | null = null;

function getSandboxBinary(): string | undefined {
  return configuredSandboxBinaryPath;
}

function getErrorMessage(error: unknown): string | undefined {
  if (error instanceof Error) {
    return error.message;
  }
  if (typeof error === "object" && error !== null && "message" in error && typeof error.message === "string") {
    return error.message;
  }
  return undefined;
}

/** Remembers the binary check's answer and its failure, if any. */
function rememberBinaryCheck(ctx: Context, available: boolean, error?: unknown): boolean {
  binaryAvailable = available;
  binaryCheckError = error;
  return available;
}

function checkBinaryAvailable(ctx: Context): boolean {
  if (binaryAvailable !== null) return binaryAvailable;
  try {
    const binaryPath = getSandboxBinary();
    logger.info(ctx, `[checkBinaryAvailable] Resolved binary path: ${binaryPath}`);
    if (!binaryPath) {
      logger.info(ctx, "[checkBinaryAvailable] Binary path not set, returning false");
      return rememberBinaryCheck(ctx, false, new Error("Sandbox binary path was not configured"));
    }
    const available = existsSync(binaryPath);
    logger.info(ctx, available ? `[checkBinaryAvailable] Binary path exists: ${available}` : `[checkBinaryAvailable] Binary not found at: ${binaryPath}`);
    return rememberBinaryCheck(ctx, available, available ? undefined : new Error(`Sandbox binary not found at ${binaryPath}`));
  } catch (error) {
    logger.info(ctx, `[checkBinaryAvailable] Exception checking binary: ${error}`);
    return rememberBinaryCheck(ctx, false, error);
  }
}

function applyConfiguredRipgrepToSandboxEnv(env: NodeJS.ProcessEnv): void {
  if (process.platform !== "linux") {
    return;
  }
  Object.assign(env, withConfiguredRipgrepEnv(env));
}

/** The environment a preflight runs with: the process's own, pointed at the configured search binary. */
function preflightEnv(): NodeJS.ProcessEnv {
  const env = { ...process.env };
  applyConfiguredRipgrepToSandboxEnv(env);
  return env;
}

/** The empty policy a preflight runs against: no rules at all, plus the directory policies are written to. */
function preflightSandboxPolicy(cwd: string): ReturnType<typeof buildNativeSandboxPolicy> {
  const preflightPolicy: NativeSandboxPolicyInput = { type: "workspace_readwrite" };
  return buildNativeSandboxPolicy(withSandboxPolicyDirectoryReadonly(preflightPolicy), cwd);
}

function buildPreflightInvocation(ctx: Context, cwd: string): PreflightInvocation {
  const unifiedPolicy = { sandbox: preflightSandboxPolicy(cwd) };
  const binaryPath = String(getSandboxBinary());
  logger.info(ctx, `[sandboxPreflight] Running preflight with binary: ${binaryPath}`);
  logger.info(ctx, `[sandboxPreflight] CWD: ${cwd}`);
  const env = preflightEnv();
  const policyFilePath = writeSandboxPolicyFile(JSON.stringify(unifiedPolicy));
  return {
    binaryPath,
    args: ["--policy", policyFilePath, "--preflight-only", "--", "/bin/true"],
    env,
  };
}

/** What a failed preflight is remembered as: an unsupported kernel is said so, anything else with its status. */
function preflightFailureReason(failure: PreflightFailure): string {
  const stderrText = failure.stderrText || "none";
  if (failure.status === 2) return `Linux preflight failed with exit code 2 (unsupported kernel features). stderr: ${stderrText}`;
  return `Linux preflight failed: ${failure.message || "unknown error"}. Exit status: ${failure.status}. stderr: ${stderrText}`;
}

function recordPreflightFailure(ctx: Context, failure: PreflightFailure): false {
  const { message, status, stderrText } = failure;
  logger.error(ctx, `[sandboxPreflight] Preflight failed: ${message}`, failure);
  logger.error(ctx, `[sandboxPreflight] Exit status: ${status}`, failure);
  if (stderrText) {
    logger.error(ctx, `[sandboxPreflight] Stderr: ${stderrText}`, failure);
  }
  lastSandboxFailureReason = preflightFailureReason({ ...(message === undefined ? {} : { message }), ...(status === undefined ? {} : { status }), ...(stderrText === undefined ? {} : { stderrText }) });
  cachedSandboxHelperSupported = false;
  return false;
}

/** Records why the helper is not usable here and caches the answer. */
function markUnsupported(reason: string | null): false {
  lastSandboxFailureReason = reason;
  cachedSandboxHelperSupported = false;
  return false;
}

/** Records that the helper is usable here and caches the answer. */
function markSupported(ctx: Context, note: string): true {
  lastSandboxFailureReason = null;
  cachedSandboxHelperSupported = true;
  logger.info(ctx, note);
  return true;
}

/** The failure a thrown preflight error carries, as much as it says. */
function preflightFailureFrom(error: unknown): PreflightFailure {
  const message = error instanceof Error
    ? error.message
    : typeof error === "object" && error !== null && "message" in error && typeof error.message === "string"
      ? error.message
      : undefined;
  const status = typeof error === "object" && error !== null && "status" in error && typeof error.status === "number"
    ? error.status
    : undefined;
  const stderrValue = typeof error === "object" && error !== null && "stderr" in error ? error.stderr : undefined;
  const stderrText = stderrValue !== undefined && stderrValue !== null && typeof stderrValue === "object" && "toString" in stderrValue && typeof stderrValue.toString === "function"
    ? stderrValue.toString()
    : "";
  const failure: PreflightFailure = { stderrText };
  if (message !== undefined) failure.message = message;
  if (status !== undefined) failure.status = status;
  return failure;
}

export function isSandboxHelperSupported(ctx?: Context): boolean {
  if (cachedSandboxHelperSupported !== null) {
    return cachedSandboxHelperSupported;
  }
  const effectiveCtx = ctx ?? createContext();
  logger.info(effectiveCtx, "[isSandboxHelperSupported] Starting sandbox support check...");
  if (!checkBinaryAvailable(effectiveCtx)) {
    const reason = getErrorMessage(binaryCheckError) ?? "Binary check failed";
    logger.info(effectiveCtx, `[isSandboxHelperSupported] Binary not available, returning false. Reason: ${reason}`);
    return markUnsupported(reason);
  }
  if (process.platform === "win32") {
    logger.info(effectiveCtx, "[isSandboxHelperSupported] win32: returning false (proxy-only, no filesystem sandbox)");
    return markUnsupported("Windows sandbox helper only provides network proxy, not filesystem isolation");
  }
  if (isMacOS) return markSupported(effectiveCtx, `[isSandboxHelperSupported] ${process.platform} platform, binary available, sandbox supported!`);
  return runPreflightProbe(effectiveCtx);
}

/** Runs the helper once against an empty policy and a command that does nothing, and reports whether it started. */
function runPreflightProbe(ctx: Context): boolean {
  const { binaryPath, args, env } = buildPreflightInvocation(ctx, process.cwd());
  try {
    const preflightStart = Date.now();
    execFileSync(binaryPath, args, {
      stdio: ["ignore", "ignore", "pipe"],
      timeout: PREFLIGHT_PROBE_TIMEOUT_MS,
      env,
      shell: false,
    });
    const preflightMs = Date.now() - preflightStart;
    return markSupported(ctx, `[isSandboxHelperSupported] Preflight succeeded in ${preflightMs}ms, sandbox supported!`) || cachedSandboxHelperSupported;
  } catch (error) {
    return recordPreflightFailure(ctx, preflightFailureFrom(error));
  }
}

/** Only the fields that are set: a policy object carries exactly what it names, in the order the policy takes them. */
function onlySetFields<T extends object>(fields: T): Partial<T> {
  return Object.fromEntries(Object.entries(fields).filter(([, value]) => value !== undefined)) as Partial<T>;
}

/** The helper's own network rules, in the shape the policy file wants. */
function networkPolicyForFile(networkPolicy: HelperNetworkPolicy): NonNullable<NativeSandboxPolicyInput["networkPolicy"]> {
  return {
    version: 1,
    default: networkPolicy.default ?? "deny",
    ...(networkPolicy.allow === undefined ? {} : { allow: networkPolicy.allow }),
    ...(networkPolicy.deny === undefined ? {} : { deny: networkPolicy.deny }),
  };
}

function toNativeSandboxPolicyInput(policy: SandboxHelperPolicy): NativeSandboxPolicyInput {
  const networkPolicy = policy.networkPolicy;
  return {
    type: policy.type,
    ...onlySetFields({
      readBoundary: policy.readBoundary,
      additionalReadPaths: policy.additionalReadPaths,
      additionalReadwritePaths: policy.additionalReadwritePaths,
      additionalReadonlyPaths: policy.additionalReadonlyPaths,
      writeProtectionMapping: policy.writeProtectionMapping,
      ignoreMapping: policy.ignoreMapping,
    }),
    ...(networkPolicy === undefined ? {} : { networkPolicy: networkPolicyForFile(networkPolicy) }),
    ...onlySetFields({ disableTmpWrite: policy.disableTmpWrite }),
  };
}

/** A policy that says the command is not sandboxed: it is run directly. */
function isInsecurePolicy(policy: SandboxHelperPolicy): boolean {
  return policy.type === "insecure_none";
}

/** A policy that names a workspace: it is run through the helper. */
function isWorkspacePolicy(policy: SandboxHelperPolicy): boolean {
  return policy.type === "workspace_readwrite" || policy.type === "workspace_readonly";
}

export function spawnWithSandboxHelper(
  command: string,
  args: readonly string[] = [],
  options: SpawnOptions = {},
  sandboxPolicy: SandboxHelperPolicy,
): ChildProcess {
  const ctx = createContext();
  options.env = filterElectronEnv(options.env);
  if (!checkBinaryAvailable(ctx)) {
    throw new Error(`Sandbox binary not available: ${getErrorMessage(binaryCheckError) ?? "binary not configured"}. Please build the binary or use 'insecure_none' policy.`);
  }
  if (isInsecurePolicy(sandboxPolicy)) return spawn(command, args, options);
  if (isWorkspacePolicy(sandboxPolicy)) return spawnWithSandboxHelperPolicy(command, args, options, sandboxPolicy);
  throw new Error(`Unsupported sandbox policy: ${String(sandboxPolicy)}`);
}

/** A command a shell would run, projected into the shell that would run it. */
function projectShellCommand(command: string, args: readonly string[], shell: SpawnOptions["shell"]): { actualCommand: string; actualArgs: string[] } {
  if (!shell) return { actualCommand: command, actualArgs: [...args] };
  if (process.platform === "win32") {
    return { actualCommand: typeof shell === "string" ? shell : "cmd.exe", actualArgs: ["/c", `${command} ${args.join(" ")}`] };
  }
  return { actualCommand: typeof shell === "string" ? shell : "/bin/sh", actualArgs: ["-c", `${command} ${args.join(" ")}`] };
}

/** The policy file the helper is pointed at: the filesystem policy, and the network rules beside it. */
function writeUnifiedPolicyFile(sandbox: ReturnType<typeof buildNativeSandboxPolicy>, sandboxPolicy: SandboxHelperPolicy): string {
  const resolvedNetworkPolicy = resolveNetworkPolicyForFile(sandboxPolicy);
  const unifiedPolicy: { sandbox: typeof sandbox; networkPolicy?: HelperNetworkPolicy; networkPolicyStrict?: false } = { sandbox };
  if (resolvedNetworkPolicy !== undefined) unifiedPolicy.networkPolicy = resolvedNetworkPolicy;
  if (sandboxPolicy.networkPolicyStrict === false) unifiedPolicy.networkPolicyStrict = false;
  return writeSandboxPolicyFile(JSON.stringify(unifiedPolicy));
}

/** The environment and streams the helper's child runs with. */
function helperSpawnOptions(options: SpawnOptions, executionCwd: string): SpawnOptions {
  const baseEnv = process.platform === "linux" ? scrubSocketEnvVars(process.env) : process.env;
  const optionsEnv = process.platform === "linux" && options.env !== undefined ? scrubSocketEnvVars(options.env) : options.env;
  const mergedEnv: NodeJS.ProcessEnv = { ...baseEnv, ...optionsEnv, SLATE_SANDBOX: "native" };
  applyConfiguredRipgrepToSandboxEnv(mergedEnv);
  return { cwd: options.cwd || executionCwd, env: mergedEnv, stdio: options.stdio || ["pipe", "pipe", "pipe"] };
}

export function spawnWithSandboxHelperPolicy(
  command: string,
  args: readonly string[] = [],
  options: SpawnOptions = {},
  sandboxPolicy: SandboxHelperPolicy,
): ChildProcess {
  if (!isWorkspacePolicy(sandboxPolicy)) throw new Error("Expected workspace_readwrite or workspace_readonly policy");
  const executionCwd = String(options.cwd ?? process.cwd());
  const { actualCommand, actualArgs } = projectShellCommand(command, args, options.shell);
  const sandbox = buildNativeSandboxPolicy(
    withSandboxPolicyDirectoryReadonly(toNativeSandboxPolicyInput(sandboxPolicy)),
    sandboxPolicy.sandboxWorkspaceRoot ?? executionCwd,
  );
  const sandboxArgs = ["--policy", writeUnifiedPolicyFile(sandbox, sandboxPolicy), "--", actualCommand, ...actualArgs];
  const spawnOptions = helperSpawnOptions(options, executionCwd);
  return spawnWithMetadata(sandboxArgs, spawnOptions);
}

/** Spawns the helper, and on macOS registers what the log needs to find the child's denials. */
function spawnWithMetadata(sandboxArgs: readonly string[], spawnOptions: SpawnOptions): ChildProcess {
  try {
    const startTime = new Date();
    const child = spawn(String(getSandboxBinary()), [...sandboxArgs], spawnOptions);
    if (isMacOS && child.pid) registerSandboxMetadata(child, { startTime, pid: child.pid });
    return child;
  } catch (error) {
    throw new Error(`Failed to spawn sandboxed process: ${error}`);
  }
}

export function getLastSandboxFailureReason(): string | null {
  return lastSandboxFailureReason;
}
