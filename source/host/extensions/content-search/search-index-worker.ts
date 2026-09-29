/**
 * Indexing a transcript in a worker of its own.
 *
 * The worker is handed what to index and answers with what it did, and a database that turns out to be corrupt is
 * reported as such rather than retried as if it were busy.
 */
import { isMainThread, parentPort, workerData } from "node:worker_threads";
import { invariant } from "../../../shared/invariant.ts";
import { isSqliteCorruptError } from "../../storage/sqlite-busy.ts";
import { ensureSearchIndexSchema, openSearchIndexDb } from "./search-index-db.ts";
import { SlateSearchIndexWriter, type SearchIndexJob } from "./search-index-writer.ts";
export interface SearchIndexWorkerRequest { readonly requestId: number; readonly job: SearchIndexJob }
export interface SearchIndexWorkerResponse { readonly requestId: number; readonly ok: boolean; readonly message?: string; readonly isIndexCorrupt?: boolean }
export function startSearchIndexWorker(config: { readonly indexDbPath: string; readonly agentsRootDir: string }, port: { on(event: "message", listener: (request: SearchIndexWorkerRequest) => void): unknown; postMessage(value: SearchIndexWorkerResponse): void }): () => void { const db = openSearchIndexDb(config.indexDbPath); ensureSearchIndexSchema(db); const writer = new SlateSearchIndexWriter(db, config.agentsRootDir); port.on("message", (request) => { let response: SearchIndexWorkerResponse; try { writer.runJob(request.job); response = { requestId: request.requestId, ok: true }; } catch (error) { response = { requestId: request.requestId, ok: false, message: error instanceof Error ? error.message : String(error), isIndexCorrupt: isSqliteCorruptError(error) }; } port.postMessage(response); }); return () => { writer.close(); db.close(); }; }
if (!isMainThread) {
  const port = parentPort;
  invariant(port != null, "search-index-worker must run as a worker_thread");
  const config = workerData as { indexDbPath?: unknown; agentsRootDir?: unknown } | null;
  invariant(typeof config?.indexDbPath === "string" && typeof config.agentsRootDir === "string", "search-index-worker needs indexDbPath + agentsRootDir");
  startSearchIndexWorker({ indexDbPath: config.indexDbPath, agentsRootDir: config.agentsRootDir }, port);
}
