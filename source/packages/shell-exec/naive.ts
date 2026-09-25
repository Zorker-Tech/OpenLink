/**
 * The shell that is not a shell: a command run through a plain program, and how a shell is chosen.
 *
 * Two things live here because they are two halves of the same decision. The first is the executor used when
 * no shell of the user's own is worth driving: a command is handed to a program directly, its output is
 * streamed, and the caller is told when its input is ready and when it has exited. What a stateful shell
 * adds is the state between commands, and this one has none — which is also why it is the fallback rather
 * than the default. The policy a command runs under is resolved here, from the workspace it is run in and
 * whatever sources the caller has, so that the same resolution serves every shell.
 *
 * The second is the choice of shell. A user's own shell is preferred, since a command written for their
 * environment expects it; a hint from the terminal they are in is trusted first, then what the platform
 * detects about the machine, and only if nothing is found does the plain executor get used. Two of those
 * choices are platform-specific and are made carefully: bash on Windows is only usable when it is Git's
 * bash rather than the one Windows ships, and PowerShell is looked for under both of its names, the modern
 * one first. The executor that comes back is lazy, so that the work of starting a shell happens when a
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
  execute(ctx: Context, command: string, options?: TerminalExecuteOptions): AsyncIterable<TerminalEvent>;
}

export interface DefaultTerminalExecutorOptions {
  readonly env?: NodeJS.ProcessEnv;
  readonly shell?: string;
  readonly shellArgs?: readonly string[];
  readonly userTerminalHint?: string;
  readonly statefulFactories?: Partial<Record<KnownShellExecutor.Zsh | KnownShellExecutor.ZshLight | KnownShellExecutor.Bash | KnownShellExecutor.PowerShell, (options?: DefaultTerminalExecutorOptions) => Promise<TerminalExecutor>>>;
}

export class NaiveTerminalExecutor implements TerminalExecutor {
  constructor(private readonly cwd: string, private readonly options: DefaultTerminalExecutorOptions = {}) {}
  async getCwd(): Promise<string> { return this.cwd; }
  clone(workingDirectory?: string): TerminalExecutor { return new NaiveTerminalExecutor(workingDirectory ?? this.cwd, this.options); }
  async *execute(ctx: Context, command: string, options: TerminalExecuteOptions = {}): AsyncIterable<TerminalEvent> {
    using span = createSpan(ctx.withName("NaiveTerminalExecutor.execute"));
    const iterable = createWritableIterable<TerminalEvent>();
    const pipeStdin = options.pipeStdin ?? false;
    const env = {
      ...process.env,
      ...SHELL_ENV_OVERRIDES,
      ...options.env,
    };
    const transformedCommand = shouldEnableSudoAskpass(env) ? transformSudoCommand(command) : command;
    const cwd = options.workingDirectory ?? this.cwd;
    const sandboxWorkspaceRoot = options.sandboxWorkspaceRoot ?? cwd;
    const resolvedPolicy = await resolveSandboxPolicyForWorkspace(sandboxWorkspaceRoot, options.sandboxPolicy as SandboxPolicySources | undefined);
    const sandboxPolicy = resolvedPolicy.policy.type !== "insecure_none"
      ? { ...resolvedPolicy.policy, sandboxWorkspaceRoot }
      : resolvedPolicy.policy;
    const child = spawnWithSignal(this.options.shell || process.env.SHELL || "/bin/sh", [...this.options.shellArgs ?? [], "-c", transformedCommand], {
      env,
      // Use 'ignore' for stdin unless interactive, to prevent background processes from inheriting an open stdin pipe.
      stdio: [pipeStdin ? "pipe" : "ignore", "pipe", "pipe"],
    }, sandboxPolicy, options.signal);
    child.on("spawn", async () => {
      try {
        await iterable.write({ type: "stdin_ready", stdin: child.stdin ?? undefined, pid: child.pid });
      } catch {
        // The consumer may have closed the iterable before spawn was observed.
      }
    });
    const outputPump = attachShellOutputStreams({
      stdout: child.stdout,
      stderr: child.stderr,
      writable: iterable,
      bufferOutputEvents: options.bufferOutputEvents,
      outputLimiterOptions: options.outputLimiterOptions as OutputLimiterOptions | undefined,
    });
    child.on("error", (error) => {
      iterable.throw(error);
    });
    child.on("exit", async (code) => {
      reportEvent(span.ctx, "exit");
      await outputPump.flush();
      if (sandboxPolicy.captureDenies ?? false) {
        try {
          const denyEvents = await captureSandboxDenies(child);
          if (denyEvents && denyEvents.length > 0) {
            await iterable.write({ type: "sandbox_denies", events: denyEvents });
          }
        } catch {
          // Sandbox diagnostics are best-effort after process exit.
        }
      }
      try {
        await iterable.write({
          type: "exit",
          code,
          data: "",
          aborted: options.signal?.aborted ?? false,
        });
        iterable.close();
      } catch {
        iterable.close();
      }
    });
    yield* iterable;
  }
}

export function createNaiveTerminalExecutor(options: DefaultTerminalExecutorOptions = {}): TerminalExecutor {
  return new NaiveTerminalExecutor(process.cwd(), options);
}

function commandExists(command: string): boolean { return spawnSync(command, ["--version"], { stdio: "ignore" }).error === undefined; }
function detectGitBashFromEnvironment(): string | undefined {
  if (process.platform !== "win32" || !process.env.MSYSTEM) return undefined;
  const executablePath = process.env.EXEPATH;
  if (executablePath) { const normalized = executablePath.replace(/[\\/]+$/, ""); const base = win32.basename(normalized).toLowerCase(); return base === "bash.exe" ? normalized : base === "bin" ? win32.join(normalized, "bash.exe") : win32.join(normalized, "bin", "bash.exe"); }
  return "C:\\Program Files\\Git\\bin\\bash.exe";
}

export function getSuggestedShell(userTerminalHint: string): KnownShellExecutor {
  if (userTerminalHint === KnownShellExecutor.ZshLight) return KnownShellExecutor.ZshLight;
  const shell = userTerminalHint || process.env.SHELL || ""; const windows = process.platform === "win32"; const gitBash = windows && !userTerminalHint ? detectGitBashFromEnvironment() : undefined;
  const isGitBash = gitBash !== undefined || /git.*bash\.exe$/i.test(shell) || /program.*git.*bin.*bash\.exe$/i.test(shell); const bashIsOkay = !windows || isGitBash;
  if (shell.includes("zsh")) return KnownShellExecutor.Zsh;
  if (shell.includes("bash") && bashIsOkay) return KnownShellExecutor.Bash;
  if (shell.includes("pwsh") || shell.includes("powershell")) return KnownShellExecutor.PowerShell;
  if (gitBash) return KnownShellExecutor.Bash;
  if (windows && (commandExists("pwsh") || commandExists("powershell"))) return KnownShellExecutor.PowerShell;
  if (commandExists("zsh")) return KnownShellExecutor.Zsh;
  if (commandExists("bash") && bashIsOkay) return KnownShellExecutor.Bash;
  if (commandExists("pwsh") || commandExists("powershell")) return KnownShellExecutor.PowerShell;
  return KnownShellExecutor.Naive;
}

export function createDefaultTerminalExecutor(options: DefaultTerminalExecutorOptions = {}): TerminalExecutor {
  let effective = options; const gitBashPath = options.userTerminalHint ? undefined : detectGitBashFromEnvironment(); if (gitBashPath) effective = { ...options, userTerminalHint: gitBashPath };
  const suggested = getSuggestedShell(effective.userTerminalHint ?? "");
  if (suggested === KnownShellExecutor.Naive) return createNaiveTerminalExecutor(effective);
  const override = effective.statefulFactories?.[suggested];
  if (override !== undefined) return new LazyTerminalExecutor(() => override(effective));
  switch (suggested) {
    case KnownShellExecutor.Zsh:
      return new LazyTerminalExecutor(() => initZshState(effective));
    case KnownShellExecutor.Bash:
      return new LazyTerminalExecutor(() => initBashState(effective));
    case KnownShellExecutor.PowerShell:
      return new LazyTerminalExecutor(() => initPowerShellState());
    case KnownShellExecutor.ZshLight:
      return new LazyTerminalExecutor(() => initZshLightState(effective));
    default:
      return createNaiveTerminalExecutor(effective);
  }
}
