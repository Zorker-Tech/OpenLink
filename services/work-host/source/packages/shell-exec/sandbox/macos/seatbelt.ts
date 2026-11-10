/**
 * Reading back what a sandboxed command was refused.
 *
 * The sandbox does not tell the process it refused; the kernel writes the decision to the system log instead, with the
 * process that asked, the decision it was given and what it was reaching for. So a denial is read out of the log
 * afterwards, inside the window the command was running in, and a line that reports a repeat of the same denial is
 * counted rather than repeated.
 *
 * What the log cannot say is whether a denial belongs to this command or to something else on the machine, so every
 * event carries how it relates to the process that was sandboxed: the command itself, a process already known to be
 * unrelated, or one that could be either. Only the caller can settle that, because only it knows what the command was
 * meant to do.
 */

import { execFile, type ChildProcess } from "node:child_process";

/** What is known about a sandboxed process: who it is, when it started, and which pids are certainly not it. */
type SandboxedProcess = {
  pid: number;
  startTime: Date;
  unrelatedPids?: Set<number>;
};

/** How a denial relates to the process that was sandboxed. */
type DenialRelationship = "related" | "probably_unrelated" | "maybe_related";

/** One line of the log, as the caller receives it: a denial if it says one, and the line itself either way. */
type DenialEvent =
  | { raw: string }
  | { timestamp: unknown; duplicateCount?: number; raw: string }
  | {
      timestamp: unknown;
      processName: string;
      pid: number;
      decision: string;
      decisionCode: number;
      operation: string;
      target: string;
      duplicateCount: number;
      raw: string;
      relationship: DenialRelationship;
    };

/** A denial as the sandbox writes it, once its `Sandbox: ` prefix is off: `name(pid) decision(code) operation target`. */
const DENIAL = /^([^(]+)\((\d+)\)\s+([a-zA-Z-]+)\((\d+)\)\s+([^\s]+)\s+(.+)$/;

/** The prefix every denial line carries, and no repeat line does. */
const SANDBOX_PREFIX = /^Sandbox:\s+/;

/** A line that reports how many times the denial after it was repeated. */
const REPEAT = /^(\d+) duplicate report for Sandbox: (.+)$/;

/** Where the kernel's records come from, and how long a window to read. */
const LOG_BINARY = "/usr/bin/log";

const sandboxed = new WeakMap<ChildProcess, SandboxedProcess>();

export function registerSandboxMetadata(child: ChildProcess, metadata: SandboxedProcess): void {
  sandboxed.set(child, metadata);
}

/** Runs the log query, or fails: a log that cannot be read is reported as one event, not as no denials at all. */
function runLogQuery(args: readonly string[]): Promise<string> {
  return new Promise((resolve, reject) => {
    execFile(LOG_BINARY, [...args], (error, stdout) => {
      if (error) reject(error);
      else resolve(stdout);
    });
  });
}

/**
 * What the log says this process was refused.
 *
 * A sandbox whose metadata is unknown has nothing to read against, so nothing is read; a log that cannot be queried is
 * reported as a single event carrying the failure, because an unreadable log is not the same as a command that was
 * allowed to do everything.
 */
export async function captureSandboxDenies(
  child: ChildProcess,
  options?: { readonly runLogQuery?: (args: readonly string[]) => Promise<string> },
): Promise<DenialEvent[]> {
  const metadata = sandboxed.get(child);
  if (metadata === undefined) return [];
  const since = Math.ceil((Date.now() - metadata.startTime.getTime()) / 1e3);
  const query = [
    "show",
    "--style",
    "ndjson",
    "--predicate",
    'process=="kernel" AND eventMessage CONTAINS "Sandbox:" AND eventMessage contains "deny"',
    "--last",
    since.toString(),
  ];
  let output: string;
  try {
    output = await (options?.runLogQuery ?? runLogQuery)(query);
  } catch (error) {
    return [{ raw: error instanceof Error ? error.message : String(error) }];
  }
  return output
    .split(/\r?\n/)
    .filter((line) => line.trim().length > 0)
    .map((line) => readLine(line, metadata))
    .filter((event): event is DenialEvent => event !== null);
}

/** One logged line as an event, or nothing when the line is not a record this reader understands. */
function readLine(line: string, metadata: SandboxedProcess): DenialEvent | null {
  let record: { eventMessage?: unknown; timestamp?: unknown };
  try {
    record = JSON.parse(line) as { eventMessage?: unknown; timestamp?: unknown };
  } catch {
    return null;
  }
  const message = record.eventMessage;
  if (typeof message !== "string" || message.length === 0) return null;

  // A repeat line names the denial it repeats, so it is read first: its body is a denial without the prefix.
  const repeat = REPEAT.exec(message);
  if (repeat !== null) {
    const repeats = Number(repeat[1]);
    const repeated = DENIAL.exec(repeat[2] ?? "");
    if (repeated === null) return { timestamp: record.timestamp, duplicateCount: repeats, raw: message };
    return asDenial(repeated, { timestamp: record.timestamp, raw: message, repeats, metadata });
  }

  const denial = DENIAL.exec(message.replace(SANDBOX_PREFIX, ""));
  return denial === null ? { timestamp: record.timestamp, raw: message } : asDenial(denial, { timestamp: record.timestamp, raw: message, repeats: 1, metadata });
}

/** Turns the groups of a denial line into an event, with how it relates to the sandboxed process. */
function asDenial(
  groups: RegExpExecArray,
  context: { readonly timestamp: unknown; readonly raw: string; readonly repeats: number; readonly metadata: SandboxedProcess },
): DenialEvent {
  const [, processName = "", pid = "", decision = "", decisionCode = "", operation = "", target = ""] = groups;
  const eventPid = Number(pid);
  return {
    timestamp: context.timestamp,
    processName: processName.trim(),
    pid: eventPid,
    decision: decision.toLowerCase(),
    decisionCode: Number(decisionCode),
    operation,
    target,
    duplicateCount: context.repeats,
    raw: context.raw,
    relationship: relate(eventPid, context.metadata),
  };
}

/** Whether a denial is certainly this command's, certainly not, or something only the caller can place. */
function relate(eventPid: number, metadata: SandboxedProcess): DenialRelationship {
  if (eventPid === metadata.pid) return "related";
  if (metadata.unrelatedPids?.has(eventPid) === true) return "probably_unrelated";
  return "maybe_related";
}
