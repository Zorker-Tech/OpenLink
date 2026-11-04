import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";

export function defaultIsProcessAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

export function readProcessCommand(pid: number): string | null {
  try {
    const commandLine = readFileSync(`/proc/${pid}/cmdline`, "utf8");
    if (commandLine.length > 0) return commandLine.replace(/\0/g, " ").trim();
  } catch {
    // Systems without procfs use the portable process listing below.
  }
  try {
    return execFileSync("ps", ["-p", String(pid), "-o", "command="], { encoding: "utf8", timeout: 2_000 }).trim();
  } catch {
    return null;
  }
}

export function isSlateHostProcess(pid: number): boolean {
  return readProcessCommand(pid)?.includes("host-main") === true;
}

export async function waitForProcessExit(
  pid: number,
  isAlive: (pid: number) => boolean,
  delay: (milliseconds: number) => Promise<void>,
  timeoutMs: number,
  pollIntervalMs: number,
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (isAlive(pid) && Date.now() < deadline) await delay(pollIntervalMs);
}
