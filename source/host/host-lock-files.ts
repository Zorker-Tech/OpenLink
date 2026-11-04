import { closeSync, mkdirSync, openSync, readFileSync, unlinkSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { findSystemErrno } from "../shared/system-errno.ts";

export interface HostLockHandle {
  readonly path: string;
  readonly pid: number;
  release(): void;
}

export function ensureLockDirectory(lockPath: string): void {
  mkdirSync(dirname(lockPath), { recursive: true });
}

export function readLockPid(lockPath: string): number | null {
  try {
    const pid = Number.parseInt(readFileSync(lockPath, "utf8").trim(), 10);
    return Number.isInteger(pid) && pid > 0 ? pid : null;
  } catch {
    return null;
  }
}

export function removePidLock(lockPath: string): void {
  try {
    unlinkSync(lockPath);
  } catch {
    // A lock another process already removed is no longer ours to clean up.
  }
}

export function tryCreatePidLock(lockPath: string, pid: number): boolean {
  try {
    const descriptor = openSync(lockPath, "wx");
    try {
      writeFileSync(descriptor, String(pid), "utf8");
    } finally {
      closeSync(descriptor);
    }
    return true;
  } catch (error) {
    if (findSystemErrno(error) === "EEXIST") return false;
    throw error;
  }
}

export function createPidLockHandle(lockPath: string, pid: number): HostLockHandle {
  return {
    path: lockPath,
    pid,
    release: () => {
      if (readLockPid(lockPath) === pid) removePidLock(lockPath);
    },
  };
}
