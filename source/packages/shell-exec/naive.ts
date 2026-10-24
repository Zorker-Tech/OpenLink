/**
 * The shellName that is not a shellName: a command run through a plain program, and how a shellName is chosen.
 *
 * Two things live here because they are two halves of the same decision. The first is the executor used when
 * no shellName of the user's own is worth driving: a command is handed to a program directly, its output is
 * streamed, and the caller is told when its input is ready and when it has exited. What a stateful shellName
 * adds is the state between commands, and this one has none — which is also why it is the fallback rather
 * than the default. The policy a command runs under is resolved here, from the workspace it is run in and
 * whatever sources the caller has, so that the same resolution serves every shellName.
 *
 * The second is the choice of shellName. A user's own shellName is preferred, since a command written for their
 * environment expects it; a hint from the terminal they are in is trusted first, then what the platform
 * detects about the machine, and only if nothing is found does the plain executor get used. Two of those
 * choices are platform-specific and are made carefully: bash on Windows is only usable when it is Git's
 * bash rather than the one Windows ships, and PowerShell is looked for under both of its names, the modern
 * one first. The executor that comes back is lazy, so that the work of starting a shellName happens when a
 * command is first run rather than when the session starts.
 */

import { spawnSync, type ChildProcess, type ChildProcessWithoutNullStreams } from "node:child_process";
import { delimiter, win32 } from "node:path";

import { createSpan, reportEvent } from "../context/telemetry.ts";
import type { Context } from "../context/context.ts";
import { createWritableIterable } from "../utils/writable-iterable.ts";
import { attachShellOutputStreams } from "./output-limiter.ts";
import { resolveSandboxPolicyForWorkspace } from "./sandbox/policy-merge.ts";
import { captureSandboxDenies } from "./sandbox/macos/seatbelt.ts";
import { spawnWithSignal } from "./core.ts";
import { shouldEnableSudoAskpass, transformSudoCommand } from "./sudo.ts";
import { KnownShellExecutor, SHELL_ENV_OVERRIDES } from "./types.ts";
import { initBashState } from "./bash.ts";
import { LazyTerminalExecutor } from "./lazy.ts";
import { initPowerShellState } from "./powershell.ts";
import { initZshState } from "./zsh.ts";
import { initZshLightState } from "./zsh-light.ts";

export type TerminalEvent =
  | { readonly type: "stdout" | "stderr"; readonly data: Buffer }
  | { readonly type: "suppressed_output" }
  | { readonly type: "stdin_ready"; readonly stdin: ChildProcessWithoutNullStreams["stdin"] | undefined; readonly pid: number | undefined }
  | { readonly type: "sandbox_denies"; readonly events: readonly unknown[] }
  | { readonly type: "exit"; readonly code: number | null; readonly data: ""; readonly aborted: boolean };

type SandboxPolicySources = NonNullable<Parameters<typeof resolveSandboxPolicyForWorkspace>[1]>;
type OutputLimiterOptions = Parameters<typeof attachShellOutputStreams>[0]["outputLimiterOptions"];

export interface TerminalExecuteOptions {
  readonly signal?: AbortSignal;
  readonly workingDirectory?: string;
  readonly env?: NodeJS.ProcessEnv;
  readonly pipeStdin?: boolean;
  readonly sandboxPolicy?: unknown;
  readonly sandboxWorkspaceRoot?: string;
  readonly bufferOutputEvents?: boolean;
  readonly outputLimiterOptions?: unknown;
}

export interface TerminalExecutor {
  getCwd(): Promise<string>;
  clone(workingDirectory?: string): TerminalExecutor;
  execute(ctx: Context, command: string, executionOptions?: TerminalExecuteOptions): AsyncIterable<TerminalEvent>;
}

export interface DefaultTerminalExecutorOptions {
  readonly env?: NodeJS.ProcessEnv;
  readonly shell?: string;
  readonly shellArgs?: readonly string[];
  readonly userTerminalHint?: string;
  readonly statefulFactories?: Partial<Record<KnownShellExecutor.Zsh | KnownShellExecutor.ZshLight | KnownShellExecutor.Bash | KnownShellExecutor.PowerShell, (executionOptions?: DefaultTerminalExecutorOptions) => Promise<TerminalExecutor>>>;
}

export class NaiveTerminalExecutor implements TerminalExecutor {
  constructor(private readonly workingDirectory: string, private readonly executionOptions: DefaultTerminalExecutorOptions = {}) {}
  async getCwd(): Promise<string> { return this.workingDirectory; }
  clone(workingDirectory?: string): TerminalExecutor { return new NaiveTerminalExecutor(workingDirectory ?? this.workingDirectory, this.executionOptions); }
  async *execute(ctx: Context, command: string, executionOptions: TerminalExecuteOptions = {}): AsyncIterable<TerminalEvent> {
    using span = createSpan(ctx.withName("NaiveTerminalExecutor.execute"));
    const eventStream = createWritableIterable<TerminalEvent>();
    const pipeStdin = executionOptions.pipeStdin ?? false;
    const env = {
      ...process.env,
      ...SHELL_ENV_OVERRIDES,
      ...executionOptions.env,
    };
    const finalCommand = shouldEnableSudoAskpass(env) ? transformSudoCommand(command) : command;
    const workingDirectory = executionOptions.workingDirectory ?? this.workingDirectory;
    const sandboxWorkspaceRoot = executionOptions.sandboxWorkspaceRoot ?? workingDirectory;
    const policyResolution = await resolveSandboxPolicyForWorkspace(sandboxWorkspaceRoot, executionOptions.sandboxPolicy as SandboxPolicySources | undefined);
    const sandboxPolicy = policyResolution.policy.type !== "insecure_none"
      ? { ...policyResolution.policy, sandboxWorkspaceRoot }
      : policyResolution.policy;
    const childProcess = spawnWithSignal(this.executionOptions.shell || process.env.SHELL || "/bin/sh", [...this.executionOptions.shellArgs ?? [], "-c", finalCommand], {
      env,
      // Use 'ignore' for stdin unless interactive, to prevent background processes from inheriting an open stdin pipe.
      stdio: [pipeStdin ? "pipe" : "ignore", "pipe", "pipe"],
    }, sandboxPolicy, executionOptions.signal);
    childProcess.on("spawn", async () => {
      try {
        await eventStream.write({ type: "stdin_ready", stdin: childProcess.stdin ?? undefined, pid: childProcess.pid });
      } catch {
        // The consumer may have closed the eventStream before spawn was observed.
      }
    });
    const outputs = attachShellOutputStreams({
      stdout: childProcess.stdout,
      stderr: childProcess.stderr,
      writable: eventStream,
      bufferOutputEvents: executionOptions.bufferOutputEvents,
      outputLimiterOptions: executionOptions.outputLimiterOptions as OutputLimiterOptions | undefined,
    });
    childProcess.on("error", (cause) => {
      eventStream.throw(cause);
    });
    childProcess.on("exit", async (exitCode) => {
      reportEvent(span.ctx, "exit");
      await outputs.flush();
      if (sandboxPolicy.captureDenies ?? false) {
        try {
          const deniedEvents = await captureSandboxDenies(childProcess);
          if (deniedEvents && deniedEvents.length > 0) {
            await eventStream.write({ type: "sandbox_denies", events: deniedEvents });
          }
        } catch {
          // Sandbox diagnostics are best-effort after process exit.
        }
      }
      try {
        await eventStream.write({
          type: "exit",
          code: exitCode,
          data: "",
          aborted: executionOptions.signal?.aborted ?? false,
        });
        eventStream.close();
      } catch {
        eventStream.close();
      }
    });
    yield* eventStream;
  }
}

export function createNaiveTerminalExecutor(executionOptions: DefaultTerminalExecutorOptions = {}): TerminalExecutor {
  return new NaiveTerminalExecutor(process.cwd(), executionOptions);
}

function commandExists(command: string): boolean { return spawnSync(command, ["--version"], { stdio: "ignore" }).error === undefined; }
function detectGitBashFromEnvironment(): string | undefined {
  if (process.platform !== "win32" || !process.env.MSYSTEM) return undefined;
  const exePath = process.env.EXEPATH;
  if (exePath) { const normalizedPath = exePath.replace(/[\\/]+$/, ""); const leafBase = win32.basename(normalizedPath).toLowerCase(); return leafBase === "bash.exe" ? normalizedPath : leafBase === "bin" ? win32.join(normalizedPath, "bash.exe") : win32.join(normalizedPath, "bin", "bash.exe"); }
  return "C:\\Program Files\\Git\\bin\\bash.exe";
}

export function getSuggestedShell(userTerminalHint: string): KnownShellExecutor {
  if (userTerminalHint === KnownShellExecutor.ZshLight) return KnownShellExecutor.ZshLight;
  const shellName = userTerminalHint || process.env.SHELL || ""; const runningOnWindows = process.platform === "win32"; const gitBashExecutable = runningOnWindows && !userTerminalHint ? detectGitBashFromEnvironment() : undefined;
  const bashIsGitBash = gitBashExecutable !== undefined || /git.*bash\.exe$/i.test(shellName) || /program.*git.*bin.*bash\.exe$/i.test(shellName); const bashUsable = !runningOnWindows || bashIsGitBash;
  if (shellName.includes("zsh")) return KnownShellExecutor.Zsh;
  if (shellName.includes("bash") && bashUsable) return KnownShellExecutor.Bash;
  if (shellName.includes("pwsh") || shellName.includes("powershell")) return KnownShellExecutor.PowerShell;
  if (gitBashExecutable) return KnownShellExecutor.Bash;
  if (runningOnWindows && (commandExists("pwsh") || commandExists("powershell"))) return KnownShellExecutor.PowerShell;
  if (commandExists("zsh")) return KnownShellExecutor.Zsh;
  if (commandExists("bash") && bashUsable) return KnownShellExecutor.Bash;
  if (commandExists("pwsh") || commandExists("powershell")) return KnownShellExecutor.PowerShell;
  return KnownShellExecutor.Naive;
}

export function createDefaultTerminalExecutor(executionOptions: DefaultTerminalExecutorOptions = {}): TerminalExecutor {
  let resolvedOptions = executionOptions; const gitBashPath = executionOptions.userTerminalHint ? undefined : detectGitBashFromEnvironment(); if (gitBashPath) resolvedOptions = { ...executionOptions, userTerminalHint: gitBashPath };
  const chosenShell = getSuggestedShell(resolvedOptions.userTerminalHint ?? "");
  if (chosenShell === KnownShellExecutor.Naive) return createNaiveTerminalExecutor(resolvedOptions);
  const customFactory = resolvedOptions.statefulFactories?.[chosenShell];
  if (customFactory !== undefined) return new LazyTerminalExecutor(() => customFactory(resolvedOptions));
  switch (chosenShell) {
    case KnownShellExecutor.Zsh:
      return new LazyTerminalExecutor(() => initZshState(resolvedOptions));
    case KnownShellExecutor.Bash:
      return new LazyTerminalExecutor(() => initBashState(resolvedOptions));
    case KnownShellExecutor.PowerShell:
      return new LazyTerminalExecutor(() => initPowerShellState());
    case KnownShellExecutor.ZshLight:
      return new LazyTerminalExecutor(() => initZshLightState(resolvedOptions));
    default:
      return createNaiveTerminalExecutor(resolvedOptions);
  }
}
