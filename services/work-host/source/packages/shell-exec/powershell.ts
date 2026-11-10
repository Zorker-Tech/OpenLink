/**
 * Driving PowerShell, with its state carried between commands.
 *
 * PowerShell has no equivalent of a state dump that can be replayed, so the state is read by running a script
 * that writes it: each environment variable as the command that sets it, each alias as the command that
 * defines it, skipping the ones the shell itself made read-only. Every command is then run through a wrapper
 * that restores that state, moves to the working directory, runs the command, keeps its exit code, writes the
 * state back out and exits with the command's own code rather than the wrapper's.
 *
 * The state is passed through a file rather than through the shell's output, since the output carries the
 * command's own text and mixing the two would corrupt both. The shell is started as its own process group so
 * that stopping a command stops what it started.
 */

import { randomUUID } from "node:crypto";
import { readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ChildProcess, SpawnOptions } from "node:child_process";

import { createSpan, reportEvent } from "../context/telemetry.ts";
import type { Context } from "../context/context.ts";
import { createWritableIterable } from "../utils/writable-iterable.ts";
import { attachShellOutputStreams } from "./output-limiter.ts";
import { getPowerShellExecutable } from "./platform-shell.ts";
import { resolveSandboxPolicyForWorkspace } from "./sandbox/policy-merge.ts";
import { shouldEnableSudoAskpass, transformSudoCommand } from "./sudo.ts";
import { SHELL_ENV_OVERRIDES } from "./types.ts";
import { splitPwdAndState, createShellExitEvent } from "./core.ts";
import { spawnWithSignal } from "./core.ts";
import type { SandboxExecutionPolicy } from "./sandbox/sandbox.js";
import {
  type TerminalEvent,
  type TerminalExecuteOptions,
} from "./naive.ts";
import { buildShellCommandStateWrapper } from "../../adapters/interop/shell/powershell-state-wrapper-adapter.ts";

type SandboxPolicySources = NonNullable<Parameters<typeof resolveSandboxPolicyForWorkspace>[1]>;
type OutputLimiterOptions = Parameters<typeof attachShellOutputStreams>[0]["outputLimiterOptions"];
type PowerShellExecuteOptions = Omit<TerminalExecuteOptions, "executionPolicy" | "outputLimiterOptions"> & {
  readonly sandboxPolicy?: SandboxPolicySources;
  readonly outputLimiterOptions?: OutputLimiterOptions;
  readonly closeTimeout?: number;
};
type SpawnWithSignal = (
  command: string,
  launcherArgs: readonly string[],
  settings: SpawnOptions,
  executionPolicy: SandboxExecutionPolicy,
  signal?: AbortSignal,
) => ChildProcess;

let boundSpawn: SpawnWithSignal = spawnWithSignal;

function spawnWithSignalBindingOf(): SpawnWithSignal {
  return boundSpawn;
}

const BOM_PREFIX = "\uFEFF";

async function writeScriptWithBom(filePath: string, content: string): Promise<void> {
  await writeFile(filePath, BOM_PREFIX + content, { encoding: "utf8" });
}

export async function initPowerShellState(): Promise<PowerShellSession> {
  return new PowerShellSession(process.cwd(), "");
}

class PowerShellSession {
  constructor(private scriptCwd: string, private state: string) {}

  async getCwd(): Promise<string> {
    return this.scriptCwd;
  }

  clone(workingDirectory?: string): PowerShellSession {
    return new PowerShellSession(workingDirectory ?? this.scriptCwd, this.state);
  }

  async *execute(ctx: Context, command: string, settings?: PowerShellExecuteOptions): AsyncIterable<TerminalEvent> {
    using span = createSpan(ctx.withName("PowerShellSession.execute"));
    const pipesInput = settings?.pipeStdin ?? false;
    const scriptCwd = settings?.workingDirectory ?? this.scriptCwd;
    const outputEvents = createWritableIterable<TerminalEvent>();
    const env: NodeJS.ProcessEnv = {
      ...process.env,
      ...SHELL_ENV_OVERRIDES,
      ...settings?.env,
    };
    const convertedCommand = shouldEnableSudoAskpass(env) ? transformSudoCommand(command) : command;
    const tempDirectory = tmpdir();
    const stateFilePath = join(tempDirectory, `ps-state-out-${randomUUID()}.txt`);
    const wrapperScript = buildShellCommandStateWrapper(this.state, scriptCwd, convertedCommand, stateFilePath);
    const scriptPath = join(tempDirectory, `ps-script-${randomUUID()}.ps1`);
    await writeScriptWithBom(scriptPath, wrapperScript);
    const launcherArgs = ["-ExecutionPolicy", "Bypass"];
    if (!pipesInput) launcherArgs.push("-NonInteractive");
    launcherArgs.push("-File", scriptPath);
    const executable = getPowerShellExecutable();
    const onWindows = process.platform === "win32";
    const workspaceRoot = settings?.sandboxWorkspaceRoot ?? scriptCwd;
    const mergedPolicy = (await resolveSandboxPolicyForWorkspace(workspaceRoot, settings?.sandboxPolicy)).policy;
    const executionPolicy = mergedPolicy.type !== "insecure_none" ? { ...mergedPolicy, workspaceRoot } : mergedPolicy;
    const processHandle = spawnWithSignalBindingOf()(executable, launcherArgs, {
      env,
      stdio: [pipesInput ? "pipe" : "ignore", "pipe", "pipe"],
      cwd: scriptCwd,
      detached: !onWindows,
    }, executionPolicy, settings?.signal);
    processHandle.on("spawn", async () => {
      try {
        await outputEvents.write({ type: "stdin_ready", stdin: processHandle.stdin ?? undefined, pid: processHandle.pid });
      } catch {
        // The consumer may have closed the outputEvents before spawn was observed.
      }
    });
    const outputPipes = attachShellOutputStreams({
      stdout: processHandle.stdout,
      stderr: processHandle.stderr,
      writable: outputEvents,
      bufferOutputEvents: settings?.bufferOutputEvents,
      outputLimiterOptions: settings?.outputLimiterOptions,
    });
    const removeArtifacts = async (): Promise<void> => {
      try {
        const newState = await readFile(stateFilePath, "utf8");
        const { cwd: newCwd, rest } = splitPwdAndState(newState);
        this.state = rest;
        this.scriptCwd = newCwd.trim();
        await rm(stateFilePath).catch(() => {});
      } catch {
        // PowerShell may terminate before writing a state snapshot.
      }
      await rm(scriptPath).catch(() => {});
    };
    let childExitCode: number | null = null;
    let closeTimer: ReturnType<typeof setTimeout> | null = null;
    let exitSent = false;
    const finishExecution = async (waitForOutputPumps: boolean): Promise<void> => {
      if (exitSent) return;
      exitSent = true;
      if (closeTimer !== null) {
        clearTimeout(closeTimer);
        closeTimer = null;
      }
      reportEvent(span.ctx, "exit");
      if (waitForOutputPumps) {
        try {
          await outputPipes.waitForOutput();
        } catch (error) {
          await removeArtifacts();
          outputEvents.throw(error instanceof Error ? error : new Error(String(error)));
          return;
        }
      }
      await outputPipes.flush();
      try {
        await outputEvents.write(createShellExitEvent(childExitCode, settings?.signal?.aborted ?? false));
        await removeArtifacts();
        outputEvents.close();
      } catch {
        outputEvents.close();
      }
    };
    processHandle.on("exit", (code) => {
      childExitCode = code;
      const gracePeriod = settings?.closeTimeout ?? 5_000;
      if (gracePeriod > 0) {
        closeTimer = setTimeout(() => {
          console.warn(`[shell-exec] Close event did not fire within ${gracePeriod}ms after exit. This may indicate a background process is holding file descriptors open. Proceeding anyway to prevent hang.`);
          void finishExecution(false);
        }, gracePeriod);
      }
    });
    processHandle.on("close", () => {
      void finishExecution(true);
    });
    processHandle.on("error", (error) => {
      void removeArtifacts().catch(() => {});
      outputEvents.throw(error);
    });
    yield* outputEvents;
  }
}

void initPowerShellState;
