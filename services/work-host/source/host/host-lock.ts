import { getHostLockPath } from "./host-paths.ts";
import {
  createPidLockHandle,
  ensureLockDirectory,
  readLockPid,
  removePidLock,
  tryCreatePidLock,
  type HostLockHandle,
} from "./host-lock-files.ts";
import {
  defaultIsProcessAlive,
  isSlateHostProcess,
  waitForProcessExit,
} from "./host-lock-processes.ts";

export { defaultIsProcessAlive, isSlateHostProcess, readProcessCommand } from "./host-lock-processes.ts";
export { readLockPid } from "./host-lock-files.ts";

export const DEFAULT_TAKEOVER_TIMEOUT_MS = 3_000;
export const DEFAULT_POLL_INTERVAL_MS = 100;
export const MAX_ACQUIRE_ATTEMPTS = 5;

export type HostLockOutcome = "created" | "reclaimed-dead" | "reclaimed-foreign" | "took-over";

export interface HostLockResult {
  readonly outcome: HostLockOutcome;
  readonly lock: HostLockHandle;
  readonly previousPid?: number;
}

export interface AcquireHostLockOptions {
  readonly path?: string;
  readonly pid?: number;
  readonly isProcessAlive?: (pid: number) => boolean;
  readonly isSlateHostProcess?: (pid: number) => boolean;
  readonly terminateProcess?: (pid: number, signal: NodeJS.Signals) => void;
  readonly delay?: (milliseconds: number) => Promise<void>;
  readonly takeoverTimeoutMs?: number;
  readonly pollIntervalMs?: number;
  /** The exclusive-file writer is a seam for deterministic exhaustion tests; production uses `open(..., "wx")`. */
  readonly createExclusiveFile?: (path: string, pid: number) => boolean;
}

function acquisitionResult(path: string, pid: number, outcome: HostLockOutcome, previousPid: number | undefined): HostLockResult {
  return {
    outcome,
    lock: createPidLockHandle(path, pid),
    ...(previousPid === undefined ? {} : { previousPid }),
  };
}

function signalDefault(pid: number, signal: NodeJS.Signals): void {
  try {
    process.kill(pid, signal);
  } catch {
    // A process that exited while it was being signalled needs no further action.
  }
}

export async function acquireHostLock(options: AcquireHostLockOptions = {}): Promise<HostLockResult> {
  const lockPath = options.path ?? getHostLockPath();
  const ownerPid = options.pid ?? process.pid;
  const processIsAlive = options.isProcessAlive ?? defaultIsProcessAlive;
  const isHost = options.isSlateHostProcess ?? isSlateHostProcess;
  const signalProcess = options.terminateProcess ?? signalDefault;
  const pause = options.delay ?? ((milliseconds: number) => new Promise<void>((resolve) => setTimeout(resolve, milliseconds)));
  const gracePeriodMs = options.takeoverTimeoutMs ?? DEFAULT_TAKEOVER_TIMEOUT_MS;
  const probeEveryMs = options.pollIntervalMs ?? DEFAULT_POLL_INTERVAL_MS;
  const createExclusiveFile = options.createExclusiveFile ?? tryCreatePidLock;

  ensureLockDirectory(lockPath);

  let outcome: HostLockOutcome = "created";
  let previousPid: number | undefined;
  for (let attempt = 0; attempt < MAX_ACQUIRE_ATTEMPTS; attempt += 1) {
    if (createExclusiveFile(lockPath, ownerPid)) {
      return acquisitionResult(lockPath, ownerPid, outcome, previousPid);
    }

    const lockOwnerPid = readLockPid(lockPath);
    if (lockOwnerPid == null) {
      outcome = "reclaimed-dead";
      removePidLock(lockPath);
      continue;
    }
    if (lockOwnerPid === ownerPid) {
      removePidLock(lockPath);
      continue;
    }
    if (!processIsAlive(lockOwnerPid)) {
      outcome = "reclaimed-dead";
      previousPid = lockOwnerPid;
      removePidLock(lockPath);
      continue;
    }
    if (!isHost(lockOwnerPid)) {
      outcome = "reclaimed-foreign";
      previousPid = lockOwnerPid;
      removePidLock(lockPath);
      continue;
    }

    outcome = "took-over";
    previousPid = lockOwnerPid;
    signalProcess(lockOwnerPid, "SIGTERM");
    await waitForProcessExit(lockOwnerPid, processIsAlive, pause, gracePeriodMs, probeEveryMs);
    if (processIsAlive(lockOwnerPid)) {
      signalProcess(lockOwnerPid, "SIGKILL");
      await waitForProcessExit(lockOwnerPid, processIsAlive, pause, gracePeriodMs, probeEveryMs);
    }
    removePidLock(lockPath);
  }

  throw new Error(`Could not acquire the Slate host lock after ${MAX_ACQUIRE_ATTEMPTS} attempts`);
}
