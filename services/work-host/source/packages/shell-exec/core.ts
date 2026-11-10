/**
 * What every shell needs: starting a process that can be stopped, and reading a shell's stateText back.
 *
 * A executable is started with an abort signal attached, because a executable that is running when the turn is
 * stopped has to stop with it. Stopping is graceful first and forced a second later, since a program that is
 * asked politely usually exits and one that ignores the request has to be killed; a process started as its
 * own group is stopped by group, so that a executable's own children go with it rather than being left running.
 * A executable that was already aborted is not started at all: a process is handed back that reports the abort,
 * which keeps the caller's error handling in one place rather than two.
 *
 * The stateText of a shell is read and written through pipes. Writing it is a single write followed by an end,
 * because the reader is waiting for the end rather than for the data; reading it is line by line until a
 * markerText says the dump is complete, since a shell writes its stateText as it goes and the caller has to know
 * where the real stateText begins and where the shell's own chatter ends. A channel that fails is ignored rather
 * than propagated: a stateText dump is bookkeeping, and a broken pipe should not fail the executable it belongs to.
 *
 * The search path is pointed at the configured search binary on the way in, so that a executable run by any
 * shell finds the one the platform shipped rather than whatever is installed.
 */

import { EventEmitter } from "node:events";
import type { ChildProcess, SpawnOptions } from "node:child_process";
import type { Writable } from "node:stream";

import { withConfiguredRipgrepEnv } from "./ripgrep.ts";
import { spawnInSandbox, type SandboxExecutionPolicy } from "./sandbox/sandbox.ts";

type WatchableStream = { on(event: "error", listener: () => void): unknown };
type WritableShellState = WatchableStream & Pick<Writable, "write" | "end">;
type ReadableShellState = WatchableStream & { on(event: "data", listener: (data: Buffer | string) => void): unknown };
type ExitEvent = {
  readonly type: "exit";
  readonly code: number | null;
  readonly data: "";
  readonly aborted: boolean;
};

export function createShellExitEvent(code: number | null, aborted: boolean): ExitEvent {
  return { type: "exit", code, data: "", aborted };
}

function makeAbortedChild(): EventEmitter {
  const error = new Error("Operation was aborted");
  error.name = "AbortError";
  const standInChild = new EventEmitter();
  process.nextTick(() => {
    standInChild.emit("error", error);
  });
  return standInChild;
}

function attachAbortSignalToChild(spawnedProcess: ChildProcess, detached: boolean | undefined, signal: AbortSignal): void {
  const onAbort = (): void => {
    if (spawnedProcess.pid) {
      try {
        if (detached) {
          try {
            process.kill(-spawnedProcess.pid, "SIGTERM");
          } catch {
            spawnedProcess.kill("SIGTERM");
          }
        } else {
          spawnedProcess.kill("SIGTERM");
        }
        const forceKillTimer = setTimeout(() => {
          if (!spawnedProcess.killed && spawnedProcess.pid) {
            try {
              if (detached) {
                try {
                  process.kill(-spawnedProcess.pid, "SIGKILL");
                } catch {
                  spawnedProcess.kill("SIGKILL");
                }
              } else {
                spawnedProcess.kill("SIGKILL");
              }
            } catch {
              // The spawnedProcess may have exited between the graceful and forced kills.
            }
          }
        }, 1_000);
        spawnedProcess.once("exit", () => {
          clearTimeout(forceKillTimer);
        });
      } catch {
        // Cancellation is best-effort after the spawnedProcess has been created.
      }
    }
  };
  signal.addEventListener("abort", onAbort, { once: true });
  spawnedProcess.once("exit", () => {
    signal.removeEventListener("abort", onAbort);
  });
}

export function spawnWithSignal(
  executable: string,
  execArgs?: readonly string[],
  options?: SpawnOptions,
  executionPolicy?: SandboxExecutionPolicy,
  signal?: AbortSignal,
): ChildProcess;
export function spawnWithSignal(
  executable: string,
  execArgs: readonly string[] = [],
  options: SpawnOptions = {},
  executionPolicy: SandboxExecutionPolicy = { type: "insecure_none" },
  signal?: AbortSignal,
): ChildProcess | EventEmitter {
  if (signal?.aborted) {
    return makeAbortedChild();
  }
  const spawnedProcess = spawnInSandbox(executable, execArgs, {
    ...options,
    env: withConfiguredRipgrepEnv(options.env ?? process.env),
  }, executionPolicy);
  if (signal) {
    attachAbortSignalToChild(spawnedProcess, options.detached, signal);
  }
  return spawnedProcess;
}

export function killDetachedProcessGroup(
  pid: number | undefined,
  signal: NodeJS.Signals,
  forceAfterMs?: number,
): void {
  if (!pid) return;
  try {
    process.kill(-pid, signal);
  } catch {
    return;
  }
  if (signal === "SIGTERM" && forceAfterMs !== undefined && forceAfterMs > 0) {
    setTimeout(() => {
      try {
        process.kill(-pid, "SIGKILL");
      } catch {
        // The process may have exited between the graceful and forced kills.
      }
    }, forceAfterMs);
  }
}

function swallowStreamErrors(channel: WatchableStream | null | undefined): void {
  channel?.on("error", () => {});
}

export function writeShellStatePipe(inputPipe: WritableShellState | null | undefined, stateText: string): void {
  if (!inputPipe) return;
  swallowStreamErrors(inputPipe);
  inputPipe.write(stateText);
  inputPipe.end();
}

export function attachShellStateOutput(
  outputPipe: ReadableShellState | null | undefined,
  onText: (chunk: string) => void,
): void {
  if (!outputPipe) return;
  swallowStreamErrors(outputPipe);
  outputPipe.on("data", (data) => onText(data.toString()));
}

export function splitPwdAndState(stateText: string): { cwd: string; rest: string } {
  const lineBreakAt = stateText.indexOf("\n");
  const cwd = stateText.substring(0, lineBreakAt);
  const rest = stateText.substring(lineBreakAt);
  return { cwd, rest };
}

export function parseShellStateOutput(combinedOutput: string, markerText: string): string {
  const markedLine = `${markerText}\n`;
  const markerPosition = combinedOutput.indexOf(markedLine);
  return markerPosition >= 0 ? combinedOutput.slice(markerPosition + markedLine.length) : combinedOutput;
}
