/** Run a store snapshot request outside the host's main event loop. */
import { parentPort } from "node:worker_threads";
import { sqliteVacuumInto } from "./sqlite-snapshot.ts";

interface SnapshotRequest {
  readonly srcPath: string;
  readonly destPath: string;
  readonly busyTimeoutMs: number;
}

type SnapshotReply = { readonly ok: true } | { readonly ok: false; readonly message: string };

const workerChannel = parentPort;
if (workerChannel === null) throw new Error("Store snapshots must run in a worker thread.");

workerChannel.on("message", (request: SnapshotRequest) => {
  let reply: SnapshotReply;
  try {
    sqliteVacuumInto(request.srcPath, request.destPath, request.busyTimeoutMs);
    reply = { ok: true };
  } catch (error) {
    reply = {
      ok: false,
      message: error instanceof Error ? error.message : String(error),
    };
  }
  workerChannel.postMessage(reply);
});
