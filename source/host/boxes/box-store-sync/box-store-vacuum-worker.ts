/**
 * Vacuuming a store database off the main thread.
 *
 * The work runs in a worker so a long vacuum does not stall the host, and what it answers with is either the copy it
 * made or the failure the database gave it.
 */
import { parentPort } from "node:worker_threads";
import { invariant } from "../../../shared/invariant.ts";
import { sqliteVacuumInto } from "./sqlite-snapshot.ts";

const port = parentPort;
invariant(port != null, "box-store-vacuum-worker must run as a worker_thread");
port.on("message", (job: { srcPath: string; destPath: string; busyTimeoutMs: number }) => {
  try {
    sqliteVacuumInto(job.srcPath, job.destPath, job.busyTimeoutMs);
    port.postMessage({ ok: true });
  } catch (error) {
    port.postMessage({
      ok: false,
      message: error instanceof Error ? error.message : String(error),
    });
  }
});
