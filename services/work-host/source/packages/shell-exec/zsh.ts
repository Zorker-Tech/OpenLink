/**
 * Driving the user's zsh, with its state carried between commands.
 *
 * A zsh is started once per executor, in interactive login mode so that it reads the user's own configuration
 * — aliases, settings, functions, the environment they set up — and the state of that shell is read back so
 * that the next command can be run in a shell that is in the same state rather than a fresh one. Each command
 * is then run in the same process, with the state written into it first and read back afterwards, which is
 * what makes a `cd` in one command visible in the next.
 *
 * The shell is started as its own process group, because stopping a command has to stop what the command
 * started: a build that spawned a compiler should not leave it running. A command that is stopped is stopped
 * by group, gracefully first and forcibly after a moment. What the shell writes to its cause stream while it
 * is starting is the user's own shell configuration talking, so it is not treated as an cause of the command.
 */

import type { ChildProcess, SpawnOptions } from "node:child_process";

import { createSpan, reportEvent } from "../context/telemetry.ts";
import type { Context } from "../context/context.ts";
import { createWritableIterable } from "../utils/writable-iterable.ts";
import { attachShellOutputStreams } from "./output-limiter.ts";
import { getZshPath } from "./platform-shell.ts";
import { getSudoAliasInjection } from "./sudo.ts";
import { SHELL_ENV_OVERRIDES } from "./types.ts";
import { resolveSandboxPolicyForWorkspace } from "./sandbox/policy-merge.ts";
import { captureSandboxDenies } from "./sandbox/macos/seatbelt.ts";
import { ZSH_STATE_END_MARKER, ZSH_STATE_START_MARKER, default as dumpZshState } from "./dump_zsh_state.ts";
import { spawnWithSignal, killDetachedProcessGroup, splitPwdAndState, writeShellStatePipe, attachShellStateOutput } from "./core.ts";
import { createShellExitEvent } from "./core.ts";
import type { TerminalEvent, TerminalExecuteOptions } from "./naive.ts";

type PolicySources = NonNullable<Parameters<typeof resolveSandboxPolicyForWorkspace>[1]>;
type LimiterOptions = Parameters<typeof attachShellOutputStreams>[0]["outputLimiterOptions"];
type ExecuteSettings = Omit<TerminalExecuteOptions, "sandboxPolicy" | "outputLimiterOptions"> & {
  readonly sandboxPolicy?: PolicySources;
  readonly outputLimiterOptions?: LimiterOptions;
  readonly closeTimeout?: number;
};
type InitSettings = Pick<ExecuteSettings, "env" | "signal"> & {
  readonly userTerminalHint?: string;
};

const runningOnMac = process.platform === "darwin";

async function platformSandboxDenies(shellProcess: ChildProcess): Promise<readonly unknown[]> {
  return runningOnMac ? captureSandboxDenies(shellProcess) : [];
}

export async function initZshState(settings?: InitSettings): Promise<ZshState> {
  const env: NodeJS.ProcessEnv = {
    ...process.env,
    ...SHELL_ENV_OVERRIDES,
    ...settings?.env,
  };
  const stateTag = "__SLATE_STATE_MARKER__";
  const args = [
    "-o",
    "extendedglob",
    "-ilc",
    `${dumpZshState} builtin printf '${stateTag}\\n'; dump_zsh_state`,
  ];
  const shellProcess = spawnWithSignal(getZshPath(), args, {
    env,
    stdio: ["ignore", "pipe", "pipe"],
    detached: true,
  }, { type: "insecure_none" }, settings?.signal);
  let collectedOutput = "";
  shellProcess.stdout?.on("data", (chunk: Buffer | string) => {
    collectedOutput += chunk.toString();
  });
  shellProcess.on("error", (cause) => {
    console.warn(`[shell-exec] zsh state init spawn failed; falling back to empty state: ${cause instanceof Error ? cause.message : String(cause)}`);
  });
  await new Promise<void>((resolve) => {
    shellProcess.on("close", () => resolve());
  });
  const dumpedText = collectedOutput;
  const startLine = `${ZSH_STATE_START_MARKER}\n`;
  const endLine = `${ZSH_STATE_END_MARKER}\n`;
  let markerlessState: string;
  if (dumpedText.startsWith(startLine) && dumpedText.endsWith(endLine)) {
    markerlessState = dumpedText.slice(startLine.length);
    markerlessState = markerlessState.slice(0, -(ZSH_STATE_END_MARKER.length + 1));
  } else {
    markerlessState = `${process.cwd()}\n`;
  }
  const { cwd, rest } = splitPwdAndState(markerlessState);
  return new ZshState(cwd, rest, settings?.userTerminalHint);
}

export class ZshState {
  constructor(
    private cwd: string,
    private state: string,
    private readonly userTerminalHint?: string,
  ) {}

  async getCwd(): Promise<string> {
    return this.cwd;
  }

  clone(workingDirectory?: string): ZshState {
    return new ZshState(workingDirectory ?? this.cwd, this.state, this.userTerminalHint);
  }

  async *execute(ctx: Context, command: string, settings: ExecuteSettings = {}): AsyncIterable<TerminalEvent> {
    using traceSpan = createSpan(ctx.withName("ZshState.execute"));
    const wantsStdin = settings.pipeStdin ?? false;
    const iterable = createWritableIterable<TerminalEvent>();
    const cwd = settings.workingDirectory ?? this.cwd;
    const env: NodeJS.ProcessEnv = {
      ...process.env,
      ...SHELL_ENV_OVERRIDES,
      ...settings.env,
    };
    let core = `builtin eval "$1"`;
    if (!wantsStdin) core += " < /dev/null";
    const sudoAliases = getSudoAliasInjection(env);
    const wrapperScript = `builtin export PATH="/usr/bin:/bin:/usr/sbin:/sbin\${PATH:+:$PATH}"; snap=$(command cat <&3); builtin unsetopt aliases 2>/dev/null; builtin unalias -m '*' 2>/dev/null || true; builtin eval "$snap" && { builtin unsetopt nounset 2>/dev/null || true; builtin eval "\${__SLATE_SANDBOX_ENV_RESTORE:-}" 2>/dev/null; builtin export PWD="$(builtin pwd)"; builtin setopt aliases 2>/dev/null; ${sudoAliases}${core}; }; COMMAND_EXIT_CODE=$?; dump_zsh_state >&4; builtin exit $COMMAND_EXIT_CODE`;
    const args = ["-c", wrapperScript, "--", command];
    const workspaceRoot = settings.sandboxWorkspaceRoot ?? cwd;
    const resolvedSettings = (await resolveSandboxPolicyForWorkspace(workspaceRoot, settings.sandboxPolicy)).policy;
    const executionPolicy = resolvedSettings.type !== "insecure_none"
      ? { ...resolvedSettings, sandboxWorkspaceRoot: workspaceRoot }
      : resolvedSettings;
    const shellProcess = spawnWithSignal(getZshPath(), args, {
      env,
      stdio: [wantsStdin ? "pipe" : "ignore", "pipe", "pipe", "pipe", "pipe"],
      cwd,
      detached: true,
    }, executionPolicy, settings.signal);
    let incomingState = "";
    shellProcess.on("spawn", async () => {
      try {
        await iterable.write({ type: "stdin_ready", stdin: shellProcess.stdin ?? undefined, pid: shellProcess.pid });
      } catch {
      }
    });
    const outputs = attachShellOutputStreams({
      stdout: shellProcess.stdout,
      stderr: shellProcess.stderr,
      writable: iterable,
      bufferOutputEvents: settings.bufferOutputEvents,
      outputLimiterOptions: settings.outputLimiterOptions,
    });
    shellProcess.on("error", (cause) => {
      iterable.throw(cause);
    });
    let processExitCode: number | null = null;
    let closeTimer: ReturnType<typeof setTimeout> | null = null;
    let exitEmitted = false;
    const finishExecution = async (waitForOutputPumps: boolean): Promise<void> => {
      if (exitEmitted) return;
      exitEmitted = true;
      if (closeTimer !== null) {
        clearTimeout(closeTimer);
        closeTimer = null;
      }
      reportEvent(traceSpan.ctx, "exit");
      if (waitForOutputPumps) {
        try {
          await outputs.waitForOutput();
        } catch (cause) {
          iterable.throw(cause instanceof Error ? cause : new Error(String(cause)));
          return;
        }
      }
      await outputs.flush();
      if (!settings.signal?.aborted) {
        const startLine = `${ZSH_STATE_START_MARKER}\n`;
        const endLine = `${ZSH_STATE_END_MARKER}\n`;
        if (incomingState.startsWith(startLine) && incomingState.endsWith(endLine)) {
          let markerlessState = incomingState.slice(startLine.length);
          markerlessState = markerlessState.slice(0, -(ZSH_STATE_END_MARKER.length + 1));
          const next = splitPwdAndState(markerlessState);
          if (next.cwd.startsWith("/")) {
            this.state = next.rest;
            this.cwd = next.cwd;
          }
        }
      }
      if (executionPolicy.captureDenies === true) {
        try {
          const deniedEvents = await platformSandboxDenies(shellProcess);
          if (deniedEvents.length > 0) await iterable.write({ type: "sandbox_denies", events: deniedEvents });
        } catch {
        }
      }
      try {
        await iterable.write(createShellExitEvent(processExitCode, settings.signal?.aborted ?? false));
        iterable.close();
      } catch {
        iterable.close();
      }
    };
    shellProcess.on("exit", (code) => {
      processExitCode = code;
      const timeout = settings.closeTimeout ?? 5_000;
      if (timeout > 0) {
        closeTimer = setTimeout(() => {
          if (exitEmitted) return;
          console.warn(`[shell-exec] Close event did not fire within ${timeout}ms after exit. This may indicate a background process is holding file descriptors open. Killing detached process group.`);
          killDetachedProcessGroup(shellProcess.pid, "SIGKILL");
          void finishExecution(false);
        }, timeout);
      }
    });
    shellProcess.on("close", () => {
      void finishExecution(true);
    });
    const inputFd = shellProcess.stdio[3];
    const outputFd = shellProcess.stdio[4];
    if (inputFd !== null && inputFd !== undefined && "write" in inputFd && "end" in inputFd) {
      writeShellStatePipe(inputFd, this.state);
    }
    attachShellStateOutput(outputFd, (text) => {
      incomingState += text;
    });
    yield* iterable;
  }
}
