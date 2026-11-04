/**
 * Driving the user's bash, with its state carried between commands.
 *
 * Bash keeps its state in more places than zsh does — POSIX options and its own options are separate sets, and
 * its functions are declared rather than listed — so starting it means reading all of them back in the form
 * that can be replayed, and each command is run with them written in first. The shell is interactive so that
 * the user's own configuration is read, and its state is dumped to a file the shell writes rather than to its
 * output stream, since the stream carries the command's output as well.
 *
 * Bash on Windows is Git's bash, and a path that reaches it is translated on the way in: a Windows path means
 * nothing to a shell that thinks in POSIX paths. The shell is started as its own process group so that
 * stopping a command stops what it started.
 */

import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import type { ChildProcess, SpawnOptions } from "node:child_process";
import { basename, join } from "node:path";
import { tmpdir } from "node:os";

import { createSpan, reportEvent } from "../context/telemetry.ts";
import type { Context } from "../context/context.ts";
import { createWritableIterable } from "../utils/writable-iterable.ts";
import { attachShellOutputStreams } from "./output-limiter.ts";
import { getBashPath, windowsPathToGitBash } from "./platform-shell.ts";
import { getSudoAliasInjection } from "./sudo.ts";
import { SHELL_ENV_OVERRIDES } from "./types.ts";
import { resolveSandboxPolicyForWorkspace } from "./sandbox/policy-merge.ts";
import { captureSandboxDenies } from "./sandbox/macos/seatbelt.ts";
import { BASH_STATE_END_MARKER, BASH_STATE_START_MARKER, default as dumpBashState } from "./dump_bash_state.ts";
import {
  attachShellStateOutput,
  createShellExitEvent,
  parseShellStateOutput,
  splitPwdAndState,
  writeShellStatePipe,
} from "./core.ts";
import { spawnWithSignal } from "./core.ts";
import type { SandboxExecutionPolicy } from "./sandbox/sandbox.js";
import {
  type TerminalEvent,
  type TerminalExecuteOptions,
} from "./naive.ts";

type SandboxPolicySources = NonNullable<Parameters<typeof resolveSandboxPolicyForWorkspace>[1]>;
type OutputLimiterOptions = Parameters<typeof attachShellOutputStreams>[0]["outputLimiterOptions"];
type BashExecuteOptions = Omit<TerminalExecuteOptions, "sandboxPolicy" | "outputLimiterOptions"> & {
  readonly sandboxPolicy?: SandboxPolicySources;
  readonly outputLimiterOptions?: OutputLimiterOptions;
  readonly closeTimeout?: number;
};
type BashInitOptions = Pick<BashExecuteOptions, "env" | "signal"> & {
  readonly userTerminalHint?: string;
};
type SpawnWithSignal = (
  userCommand: string,
  spawnArgs: readonly string[],
  settings: SpawnOptions,
  sandboxRules: SandboxExecutionPolicy,
  signal?: AbortSignal,
) => ChildProcess;

let signalSpawnBinding: SpawnWithSignal = spawnWithSignal;
const onMacOS = process.platform === "darwin";

function spawnBinding(): SpawnWithSignal {
  return signalSpawnBinding;
}

async function collectDenies(shellProcess: ChildProcess): Promise<readonly unknown[]> {
  return onMacOS ? captureSandboxDenies(shellProcess) : [];
}

export async function initBashState(settings?: BashInitOptions): Promise<BashState> {
  const environment: NodeJS.ProcessEnv = {
    ...process.env,
    ...SHELL_ENV_OVERRIDES,
    ...settings?.env,
  };
  const stateMark = "__SLATE_STATE_MARKER__";
  const spawnArgs = [
    "-O",
    "extglob",
    "-ilc",
    `${dumpBashState} builtin printf '${stateMark}\\n'; write_shell_snapshot`,
  ];
  const shellPath = getBashPath(settings?.userTerminalHint);
  if (!shellPath) throw new Error("Can't find Bash");
  const shellProcess = spawnBinding()(shellPath, spawnArgs, {
    env: environment,
    detached: true,
    stdio: ["ignore", "pipe", "pipe"],
  }, { type: "insecure_none" }, settings?.signal);
  let capturedOutput = "";
  shellProcess.stdout?.on("data", (chunk: Buffer | string) => {
    capturedOutput += chunk.toString();
  });
  shellProcess.on("error", (error) => {
    console.warn(`[shell-exec] bash state init spawn failed; falling back to empty state: ${error instanceof Error ? error.message : String(error)}`);
  });
  await new Promise<void>((resolve) => {
    shellProcess.on("close", () => resolve());
  });
  const stateSnapshot = parseShellStateOutput(capturedOutput, stateMark);
  const stateStartLine = `${BASH_STATE_START_MARKER}\n`;
  const stateEndLine = `${BASH_STATE_END_MARKER}\n`;
  let rawState: string;
  if (stateSnapshot.startsWith(stateStartLine) && stateSnapshot.endsWith(stateEndLine)) {
    rawState = stateSnapshot.slice(stateStartLine.length);
    rawState = rawState.slice(0, -(BASH_STATE_END_MARKER.length + 1));
  } else {
    rawState = `${process.cwd()}\n`;
  }
  const { cwd: workingDirectory, rest } = splitPwdAndState(rawState);
  const fileTransport = process.platform === "win32";
  const startDirectory = process.platform === "win32" ? process.cwd() : workingDirectory;
  return new BashState(startDirectory, rest, settings?.userTerminalHint, fileTransport);
}

class BashState {
  constructor(
    private workingDirectory: string,
    private state: string,
    private readonly userTerminalHint?: string,
    private readonly fileTransport = false,
  ) {}

  async getCwd(): Promise<string> {
    return this.workingDirectory;
  }

  clone(workingDirectory?: string): BashState {
    return new BashState(workingDirectory ?? this.workingDirectory, this.state, this.userTerminalHint, this.fileTransport);
  }

  async *execute(runCtx: Context, userCommand: string, settings: BashExecuteOptions = {}): AsyncIterable<TerminalEvent> {
    using span = createSpan(runCtx.withName("BashState.execute"));
    const wantsStdin = settings.pipeStdin ?? false;
    const eventStream = createWritableIterable<TerminalEvent>();
    const workingDirectory = settings.workingDirectory ?? this.workingDirectory;
    const environment: NodeJS.ProcessEnv = {
      ...process.env,
      ...SHELL_ENV_OVERRIDES,
      ...settings.env,
    };
    let evalCore = "builtin eval \"$1\"";
    if (!wantsStdin) evalCore += " < /dev/null";
    const aliasPrefix = getSudoAliasInjection(environment);
    const localFileTransport = this.fileTransport;
    let temporaryDirectory: string | undefined;
    let stateInPath: string | undefined;
    let stateOutPath: string | undefined;
    if (localFileTransport) {
      temporaryDirectory = await mkdtemp(join(tmpdir(), "cursor-bash-state-"));
      stateInPath = join(temporaryDirectory, "state-in");
      stateOutPath = join(temporaryDirectory, "state-out");
      await writeFile(stateInPath, this.state, "utf8");
      await writeFile(stateOutPath, "", "utf8").catch(() => {});
      environment.SLATE_STATE_INPUT_FILE = windowsPathToGitBash(stateInPath);
      environment.SLATE_STATE_OUTPUT_FILE = windowsPathToGitBash(stateOutPath);
    }
    const loaderScript = localFileTransport ? 'snap=$(command cat "$SLATE_STATE_INPUT_FILE")' : "snap=$(command cat <&3)";
    const writerScript = localFileTransport
      ? 'mkdir -p "$(dirname "$SLATE_STATE_OUTPUT_FILE")" 2>/dev/null; write_shell_snapshot > "$SLATE_STATE_OUTPUT_FILE"'
      : "write_shell_snapshot >&4";
    const script = `${loaderScript} && builtin shopt -s extglob && builtin eval -- "$snap" && { builtin set +u 2>/dev/null || true; builtin eval "\${__SLATE_SANDBOX_ENV_RESTORE:-}" 2>/dev/null; builtin export PWD="$(builtin pwd)"; builtin shopt -s expand_aliases 2>/dev/null; ${aliasPrefix}${evalCore}; }; COMMAND_EXIT_CODE=$?; ${writerScript}; builtin exit $COMMAND_EXIT_CODE`;
    const spawnArgs = ["-O", "extglob", "-c", script, "--", userCommand];
    const shellPath = getBashPath(this.userTerminalHint);
    if (!shellPath) throw new Error("Can't find Bash");
    const workspaceRoot = settings.sandboxWorkspaceRoot ?? workingDirectory;
    const policy = (await resolveSandboxPolicyForWorkspace(workspaceRoot, settings.sandboxPolicy)).policy;
    const sandboxRules = policy.type !== "insecure_none" ? { ...policy, workspaceRoot } : policy;
    let updatedState = "";
    const loadStateFromTransport = async (): Promise<void> => {
      if (!localFileTransport) return;
      if (!stateOutPath) {
        updatedState = this.state;
        return;
      }
      try {
        updatedState = await readFile(stateOutPath, "utf8");
      } catch (error) {
        console.warn("[shell-exec] Failed to read bash state file", error);
        updatedState = this.state;
      }
    };
    const discardStateFiles = async (): Promise<void> => {
      if (!temporaryDirectory) return;
      try {
        await rm(temporaryDirectory, { recursive: true, force: true });
      } catch {
        // Temporary state cleanup is best-effort after process completion.
      }
    };
    let shellProcess: ChildProcess;
    try {
      shellProcess = spawnBinding()(shellPath, spawnArgs, {
        env: environment,
        stdio: [wantsStdin ? "pipe" : "ignore", "pipe", "pipe", "pipe", "pipe"],
        cwd: workingDirectory,
        detached: true,
      }, sandboxRules, settings.signal);
    } catch (error) {
      await discardStateFiles();
      throw error;
    }
    shellProcess.on("spawn", async () => {
      try {
        await eventStream.write({ type: "stdin_ready", stdin: shellProcess.stdin ?? undefined, pid: shellProcess.pid });
      } catch {
        // The consumer may have closed the iterable before spawn was observed.
      }
    });
    const pump = attachShellOutputStreams({
      stdout: shellProcess.stdout,
      stderr: shellProcess.stderr,
      writable: eventStream,
      bufferOutputEvents: settings.bufferOutputEvents,
      outputLimiterOptions: settings.outputLimiterOptions,
    });
    shellProcess.on("error", async (error) => {
      await discardStateFiles();
      eventStream.throw(error);
    });
    let shellExitCode: number | null = null;
    let closeTimer: ReturnType<typeof setTimeout> | null = null;
    let exitEmitted = false;
    const finishExecution = async (waitForPumps: boolean): Promise<void> => {
      if (exitEmitted) return;
      exitEmitted = true;
      if (closeTimer !== null) {
        clearTimeout(closeTimer);
        closeTimer = null;
      }
      reportEvent(span.ctx, "exit");
      if (waitForPumps) {
        try {
          await pump.waitForOutput();
        } catch (error) {
          await discardStateFiles();
          eventStream.throw(error instanceof Error ? error : new Error(String(error)));
          return;
        }
      }
      await pump.flush();
      if (!settings.signal?.aborted) {
        await loadStateFromTransport();
        const stateStartLine = `${BASH_STATE_START_MARKER}\n`;
        const stateEndLine = `${BASH_STATE_END_MARKER}\n`;
        if (updatedState.startsWith(stateStartLine) && updatedState.endsWith(stateEndLine)) {
          let rawState = updatedState.slice(stateStartLine.length);
          rawState = rawState.slice(0, -(BASH_STATE_END_MARKER.length + 1));
          const divided = splitPwdAndState(rawState);
          this.state = divided.rest;
          if (process.platform !== "win32" && divided.cwd.startsWith("/")) this.workingDirectory = divided.cwd;
        }
      }
      if (sandboxRules.captureDenies === true) {
        try {
          const deniedEvents = await collectDenies(shellProcess);
          if (deniedEvents.length > 0) await eventStream.write({ type: "sandbox_denies", events: deniedEvents });
        } catch {
          // Sandbox diagnostics are best-effort after process exit.
        }
      }
      try {
        await eventStream.write(createShellExitEvent(shellExitCode, settings.signal?.aborted ?? false));
        eventStream.close();
      } catch {
        eventStream.close();
      }
      await discardStateFiles();
    };
    shellProcess.on("exit", (code) => {
      shellExitCode = code;
      const closeDelay = settings.closeTimeout ?? 5_000;
      if (closeDelay > 0) {
        closeTimer = setTimeout(() => {
          console.warn(`[shell-exec] Close event did not fire within ${closeDelay}ms after exit. This may indicate a background process is holding file descriptors open. Proceeding anyway to prevent hang.`);
          void finishExecution(false);
        }, closeDelay);
      }
    });
    shellProcess.on("close", () => {
      void finishExecution(true);
    });
    if (!localFileTransport) {
      const stdinFd = shellProcess.stdio[3];
      if (stdinFd !== null && stdinFd !== undefined && "write" in stdinFd && "end" in stdinFd) writeShellStatePipe(stdinFd, this.state);
      const stateFd = shellProcess.stdio[4];
      if (stateFd !== null && stateFd !== undefined) attachShellStateOutput(stateFd, (stateText) => { updatedState += stateText; });
    }
    yield* eventStream;
  }
}

void initBashState;
