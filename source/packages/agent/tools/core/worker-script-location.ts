/**
 * Where the worker scripts a tool spawns actually are.
 *
 * A tool that runs work in a worker process needs the worker's file, and the file's location depends on
 * how the platform was started: next to the module when it is running from source, and next to the entry
 * point when it is running from a bundle. The extension matters as much as the directory — a worker
 * resolved as `.ts` when the runtime was handed `.js` cannot be started — so both are decided together by
 * looking for the files rather than by assuming.
 *
 * When neither is found the module's own directory is used, which is where a worker belongs and gives the
 * caller a path to report rather than a crash here.
 */

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

/** The two shapes a worker file is written in: beside the source, or beside the built entry point. */
type WorkerExtension = "ts" | "js";

/** Where a worker file is, and what it is written in. */
interface WorkerLocation {
  dir: string;
  extension: WorkerExtension;
}

/** Whether the worker would be found in this directory with this extension. */
function workerIn(dir: string, worker: string, extension: WorkerExtension): boolean {
  return fs.existsSync(path.join(dir, `${worker}.${extension}`));
}

/** The directory the running entry point lives in, when the platform knows one. */
function entryDirectory(): string | undefined {
  const entry = process.argv[1];
  return entry === undefined ? undefined : path.dirname(entry);
}

/**
 * The worker's directory and extension, decided by which file is actually there.
 *
 * The module's own directory is tried first — that is where a worker belongs when the platform runs from source — and
 * then the entry point's, which is where a bundled build keeps it. A worker that is found nowhere is reported at the
 * module's own directory, so a caller has a path to name in the failure rather than a crash inside this resolver.
 */
export function resolveWorkerLocation(moduleUrl: string, representativeWorker: string): WorkerLocation {
  const moduleDir = path.dirname(fileURLToPath(moduleUrl));
  if (workerIn(moduleDir, representativeWorker, "ts")) return { dir: moduleDir, extension: "ts" };
  if (workerIn(moduleDir, representativeWorker, "js")) return { dir: moduleDir, extension: "js" };
  const entryDir = entryDirectory();
  if (entryDir !== undefined && workerIn(entryDir, representativeWorker, "js")) return { dir: entryDir, extension: "js" };
  return { dir: moduleDir, extension: "js" };
}
