/**
 * What every shell needs: starting a process that can be stopped, and reading a shell's state back.
 *
 * A command is started with an abort signal attached, because a command that is running when the turn is
 * stopped has to stop with it. Stopping is graceful first and forced a second later, since a program that is
 * asked politely usually exits and one that ignores the request has to be killed; a process started as its
 * own group is stopped by group, so that a command's own children go with it rather than being left running.
 * A command that was already aborted is not started at all: a process is handed back that reports the abort,
 * which keeps the caller's error handling in one place rather than two.
 *
 * The state of a shell is read and written through pipes. Writing it is a single write followed by an end,
 * because the reader is waiting for the end rather than for the data; reading it is line by line until a
 * marker says the dump is complete, since a shell writes its state as it goes and the caller has to know
 * where the real state begins and where the shell's own chatter ends. A stream that fails is ignored rather
 * than propagated: a state dump is bookkeeping, and a broken pipe should not fail the command it belongs to.
 *
 * The search path is pointed at the configured search binary on the way in, so that a command run by any
 * shell finds the one the platform shipped rather than whatever is installed.
 */

import { EventEmitter } from "node:events";
import type { ChildProcess, SpawnOptions } from "node:child_process";
import type { Writable } from "node:stream";

import { withConfiguredRipgrepEnv } from "./ripgrep.ts";
import { spawnInSandbox, type SandboxExecutionPolicy } from "./sandbox/sandbox.ts";

type ErrorAwareStream = { on(event: "error", listener: () => void): unknown };
type ShellStateInput = ErrorAwareStream & Pick<Writable, "write" | "end">;
type ShellStateOutput = ErrorAwareStream & { on(event: "data", listener: (data: Buffer | string) => void): unknown };
type ShellExitEvent = {
  readonly type: "exit";
  readonly code: number | null;
  readonly data: "";
  readonly aborted: boolean;
};

export function createShellExitEvent(code: number | null, aborted: boolean): ShellExitEvent {
  return { type: "exit", code, data: "", aborted };
}

function createAbortedChild(): EventEmitter {
  const error = new Error("Operation was aborted");
  error.name = "AbortError";
  const mockChild = new EventEmitter();
  process.nextTick(() => {
    mockChild.emit("error", error);
  });
  return mockChild;
}

function attachAbortSignalToChild(child: ChildProcess, detached: boolean | undefined, signal: AbortSignal): void {
  const abortHandler = (): void => {
    if (child.pid) {
      try {
        if (detached) {
          try {
            process.kill(-child.pid, "SIGTERM");
          } catch {
            child.kill("SIGTERM");
          }
        } else {
          child.kill("SIGTERM");
        }
        const forceKillTimeout = setTimeout(() => {
          if (!child.killed && child.pid) {
            try {
              if (detached) {
                try {
                  process.kill(-child.pid, "SIGKILL");
                } catch {
                  child.kill("SIGKILL");
                }
              } else {
                child.kill("SIGKILL");
              }
            } catch {
              // The child may have exited between the graceful and forced kills.
            }
          }
        }, 1_000);
        child.once("exit", () => {
          clearTimeout(forceKillTimeout);
        });
      } catch {
        // Cancellation is best-effort after the child has been created.
      }
    }
  };
  signal.addEventListener("abort", abortHandler, { once: true });
  child.once("exit", () => {
    signal.removeEventListener("abort", abortHandler);
  });
}

export function spawnWithSignal(
  command: string,
  args?: readonly string[],
  options?: SpawnOptions,
  sandboxPolicy?: SandboxExecutionPolicy,
  signal?: AbortSignal,
): ChildProcess;
export function spawnWithSignal(
  command: string,
  args: readonly string[] = [],
  options: SpawnOptions = {},
  sandboxPolicy: SandboxExecutionPolicy = { type: "insecure_none" },
  signal?: AbortSignal,
): ChildProcess | EventEmitter {
  if (signal?.aborted) {
    return createAbortedChild();
  }
  const child = spawnInSandbox(command, args, {
    ...options,
    env: withConfiguredRipgrepEnv(options.env ?? process.env),
  }, sandboxPolicy);
  if (signal) {
    attachAbortSignalToChild(child, options.detached, signal);
  }
  return child;
}

export function killDetachedProcessGroup(
  pid: number | undefined,
  signal: NodeJS.Signals,
  forceKillAfterMs?: number,
): void {
  if (!pid) return;
  try {
    process.kill(-pid, signal);
  } catch {
    return;
  }
  if (signal === "SIGTERM" && forceKillAfterMs !== undefined && forceKillAfterMs > 0) {
    setTimeout(() => {
      try {
        process.kill(-pid, "SIGKILL");
      } catch {
        // The process may have exited between the graceful and forced kills.
      }
    }, forceKillAfterMs);
  }
}

function ignoreStreamErrors(stream: ErrorAwareStream | null | undefined): void {
  stream?.on("error", () => {});
}

export function writeShellStatePipe(input: ShellStateInput | null | undefined, state: string): void {
  if (!input) return;
  ignoreStreamErrors(input);
  input.write(state);
  input.end();
}

export function attachShellStateOutput(
  output: ShellStateOutput | null | undefined,
  onChunk: (chunk: string) => void,
): void {
  if (!output) return;
  ignoreStreamErrors(output);
  output.on("data", (data) => onChunk(data.toString()));
}

export function splitPwdAndState(state: string): { cwd: string; rest: string } {
  const firstLineIndex = state.indexOf("\n");
  const cwd = state.substring(0, firstLineIndex);
  const rest = state.substring(firstLineIndex);
  return { cwd, rest };
}

export function parseShellStateOutput(fullOutput: string, marker: string): string {
  const markerWithNewline = `${marker}\n`;
  const markerIndex = fullOutput.indexOf(markerWithNewline);
  return markerIndex >= 0 ? fullOutput.slice(markerIndex + markerWithNewline.length) : fullOutput;
}
