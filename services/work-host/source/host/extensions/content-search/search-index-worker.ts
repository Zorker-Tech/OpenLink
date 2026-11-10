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
export interface SearchIndexWorkerConfig {
  readonly indexDbPath: string
  readonly agentsRootDir: string
}

export interface SearchIndexWorkerPort {
  on(event: "message", listener: (request: SearchIndexWorkerRequest) => void): unknown;
  postMessage(value: SearchIndexWorkerResponse): void;
}

function runIndexJob(
  request: SearchIndexWorkerRequest,
  writer: Pick<SlateSearchIndexWriter, "runJob">,
): SearchIndexWorkerResponse {
  try {
    writer.runJob(request.job)
    return { requestId: request.requestId, ok: true }
  } catch (failure) {
    return {
      requestId: request.requestId,
      ok: false,
      message: failure instanceof Error ? failure.message : String(failure),
      isIndexCorrupt: isSqliteCorruptError(failure),
    }
  }
}

export function attachSearchIndexWorker(
  port: SearchIndexWorkerPort,
  writer: Pick<SlateSearchIndexWriter, "runJob">,
): void {
  port.on("message", request => port.postMessage(runIndexJob(request, writer)))
}

export function startSearchIndexWorker(
  config: SearchIndexWorkerConfig,
  port: SearchIndexWorkerPort,
): () => void {
  const database = openSearchIndexDb(config.indexDbPath)
  ensureSearchIndexSchema(database)
  const indexWriter = new SlateSearchIndexWriter(database, config.agentsRootDir)
  attachSearchIndexWorker(port, indexWriter)
  return () => {
    indexWriter.close()
    database.close()
  };
}
if (!isMainThread) {
  const port = parentPort;
  invariant(port !== null, "Search index worker has no message port")
  const settings = workerData as { indexDbPath?: unknown; agentsRootDir?: unknown } | null
  invariant(
    typeof settings?.indexDbPath === "string" && typeof settings.agentsRootDir === "string",
    "Worker data must include the index path and agent-store path",
  )
  startSearchIndexWorker({ indexDbPath: settings.indexDbPath, agentsRootDir: settings.agentsRootDir }, port)
}
