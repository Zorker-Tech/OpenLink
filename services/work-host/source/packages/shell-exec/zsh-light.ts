/**
 * Driving the user's zsh without the cost of reading its functions.
 *
 * The full zsh dumpedState reads everything a shell has, functions included, and a shell with a large set of them
 * costs more to dumpedState than the dumpedState is worth — especially when the session only runs a few commands.
 * This is the same executor over the lighter dump: the working directory, the exported variables, the settings
 * and the aliases are carried between commands, and the functions are not. What is lost is a function the
 * user defined in their own shell, which a command that calls it by name would then not find; what is gained
 * is that starting a shell stays cheap.
 */

import type { ChildProcess, SpawnOptions } from "node:child_process";

import { createSpan, reportEvent } from "../context/telemetry.ts";
import type { Context } from "../context/context.ts";
import { createWritableIterable } from "../utils/writable-iterable.ts";
import { getZshPath } from "./platform-shell.ts";
import { attachShellOutputStreams } from "./output-limiter.ts";
import { getSudoAliasInjection } from "./sudo.ts";
import { SHELL_ENV_OVERRIDES } from "./types.ts";
import { resolveSandboxPolicyForWorkspace } from "./sandbox/policy-merge.ts";
import { captureSandboxDenies } from "./sandbox/macos/seatbelt.ts";
import { ZSH_STATE_LIGHT_MARKER, default as dumpZshStateLight } from "./dump_zsh_state_light.ts";
import {
  attachShellStateOutput,
  createShellExitEvent,
  splitPwdAndState,
  writeShellStatePipe,
} from "./core.ts";
import { spawnWithSignal } from "./core.ts";
import type { SandboxExecutionPolicy } from "./sandbox/sandbox.js";
import {
  type TerminalEvent,
  type TerminalExecuteOptions,
} from "./naive.ts";

type PolicySources = NonNullable<Parameters<typeof resolveSandboxPolicyForWorkspace>[1]>;
type LimiterOptions = Parameters<typeof attachShellOutputStreams>[0]["outputLimiterOptions"];
type LightExecuteOptions = Omit<TerminalExecuteOptions, "sandboxPolicy" | "outputLimiterOptions"> & {
  readonly sandboxPolicy?: PolicySources;
  readonly outputLimiterOptions?: LimiterOptions;
  readonly closeTimeout?: number;
};
type SpawnFunction = (
  command: string,
  args: readonly string[],
  settings: SpawnOptions,
  executionPolicy: SandboxExecutionPolicy,
  signal?: AbortSignal,
) => ChildProcess;

let spawnBinding: SpawnFunction = spawnWithSignal;
const runningOnMac = process.platform === "darwin";

function currentSpawnFunction(): SpawnFunction {
  return spawnBinding;
}

async function platformSandboxDenies(child: ChildProcess): Promise<readonly unknown[]> {
  return runningOnMac ? captureSandboxDenies(child) : [];
}

function zshBinaryPath(): string {
  return getZshPath();
}

export async function initZshLightState(settings?: LightExecuteOptions): Promise<LightShellState> {
  const env = {
    ...process.env,
    ...SHELL_ENV_OVERRIDES,
    ...settings?.env,
  };
  const stateTag = "__SLATE_STATE_MARKER__";
  const args = [
    "-o",
    "extendedglob",
    "-ilc",
    `${dumpZshStateLight} builtin printf '${stateTag}\\n'; dump_zsh_state_light`,
  ];
  const child = currentSpawnFunction()(zshBinaryPath(), args, {
    env,
    // Only provide stdio for 0/1/2 to avoid extra FDs being inherited by background processes.
    stdio: ["ignore", "pipe", "pipe"],
    detached: true,
  }, { type: "insecure_none" }, settings?.signal);
  let collectedOutput = "";
  child.stdout?.on("data", (data: Buffer | string) => {
    collectedOutput += data.toString();
  });
  child.on("error", (error) => {
    console.warn(`[shell-exec] zsh-light state init spawn failed; falling back to empty state: ${error instanceof Error ? error.message : String(error)}`);
  });
  await new Promise<void>((resolve) => {
    child.on("close", () => resolve());
  });
  const dumpedState = collectedOutput.includes(stateTag) ? collectedOutput.slice(collectedOutput.indexOf(`${stateTag}\n`) + stateTag.length + 1) : collectedOutput;
  const lightMarkerLine = `${ZSH_STATE_LIGHT_MARKER}\n`;
  const stateText = dumpedState.startsWith(lightMarkerLine) ? dumpedState.slice(lightMarkerLine.length) : `${process.cwd()}\n`;
  const { cwd, rest } = splitPwdAndState(stateText);
  return new LightShellState(cwd, rest);
}

class LightShellState {
  constructor(
    private cwd: string,
    private state: string,
  ) {}

  async getCwd(): Promise<string> {
    return this.cwd;
  }

  clone(workingDirectory?: string): LightShellState {
    return new LightShellState(workingDirectory ?? this.cwd, this.state);
  }

  async *execute(ctx: Context, command: string, settings: LightExecuteOptions = {}): AsyncIterable<TerminalEvent> {
    using traceSpan = createSpan(ctx.withName("LightShellState.execute"));
    const wantsStdin = settings.pipeStdin ?? false;
    const events = createWritableIterable<TerminalEvent>();
    const cwd = settings.workingDirectory ?? this.cwd;
    const env = {
      ...process.env,
      ...SHELL_ENV_OVERRIDES,
      ...settings.env,
    };
    let core = "builtin eval \"$1\"";
    if (!wantsStdin) core += " < /dev/null";
    const sudoAliases = getSudoAliasInjection(env);
    const wrapperScript = `builtin export PATH="/usr/bin:/bin:/usr/sbin:/sbin\${PATH:+:$PATH}"; snap=$(command cat <&3); builtin unsetopt aliases 2>/dev/null; builtin unalias -m '*' 2>/dev/null || true; ${dumpZshStateLight} builtin eval "$snap" && { builtin unsetopt nounset 2>/dev/null || true; builtin eval "\${__SLATE_SANDBOX_ENV_RESTORE:-}" 2>/dev/null; builtin export PWD="$(builtin pwd)"; builtin setopt aliases 2>/dev/null; ${sudoAliases}${core}; }; COMMAND_EXIT_CODE=$?; dump_zsh_state_light >&4; builtin exit $COMMAND_EXIT_CODE`;
    const args = ["-c", wrapperScript, "--", command];
    const sandboxWorkspaceRoot = settings.sandboxWorkspaceRoot ?? cwd;
    const resolvedSettings = await resolveSandboxPolicyForWorkspace(sandboxWorkspaceRoot, settings.sandboxPolicy);
    const executionPolicy = resolvedSettings.policy.type !== "insecure_none"
      ? { ...resolvedSettings.policy, sandboxWorkspaceRoot }
      : resolvedSettings.policy;
    const child = currentSpawnFunction()(zshBinaryPath(), args, {
      env,
      stdio: [wantsStdin ? "pipe" : "ignore", "pipe", "pipe", "pipe", "pipe"],
      cwd,
      detached: true,
    }, executionPolicy, settings.signal);
    let incomingState = "";
    child.on("spawn", async () => {
      try {
        await events.write({ type: "stdin_ready", stdin: child.stdin ?? undefined, pid: child.pid });
      } catch {
        // The consumer may have closed the events before spawn was observed.
      }
    });
    const outputs = attachShellOutputStreams({
      stdout: child.stdout,
      stderr: child.stderr,
      writable: events,
      bufferOutputEvents: settings.bufferOutputEvents,
      outputLimiterOptions: settings.outputLimiterOptions,
    });
    child.on("error", (error) => {
      events.throw(error);
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
        } catch (error) {
          events.throw(error instanceof Error ? error : new Error(String(error)));
          return;
        }
      }
      await outputs.flush();
      if (!settings.signal?.aborted) {
        const lightMarkerLine = `${ZSH_STATE_LIGHT_MARKER}\n`;
        if (incomingState.startsWith(lightMarkerLine)) {
          const stateText = incomingState.slice(lightMarkerLine.length);
          const parsedState = splitPwdAndState(stateText);
          if (parsedState.cwd.startsWith("/")) {
            this.state = parsedState.rest;
            this.cwd = parsedState.cwd;
          }
        }
      }
      if (executionPolicy.captureDenies === true) {
        try {
          const deniedEvents = await platformSandboxDenies(child);
          if (deniedEvents.length > 0) await events.write({ type: "sandbox_denies", events: deniedEvents });
        } catch {
          // Sandbox diagnostics are best-effort after process exit.
        }
      }
      try {
        await events.write(createShellExitEvent(processExitCode, settings.signal?.aborted ?? false));
        events.close();
      } catch {
        events.close();
      }
    };
    child.on("exit", (code) => {
      processExitCode = code;
      const timeout = settings.closeTimeout ?? 5_000;
      if (timeout > 0) {
        closeTimer = setTimeout(() => {
          console.warn(`[shell-exec] Close event did not fire within ${timeout}ms after exit. This may indicate a background process is holding file descriptors open. Proceeding anyway to prevent hang.`);
          void finishExecution(false);
        }, timeout);
      }
    });
    child.on("close", () => {
      void finishExecution(true);
    });
    const stateInput = child.stdio[3];
    if (stateInput !== null && stateInput !== undefined && "write" in stateInput && "end" in stateInput) {
      writeShellStatePipe(stateInput, this.state);
    }
    const stateOutput = child.stdio[4];
    if (stateOutput !== null && stateOutput !== undefined) {
      attachShellStateOutput(stateOutput, (text) => {
        incomingState += text;
      });
    }
    yield* events;
  }
}

void initZshLightState;
