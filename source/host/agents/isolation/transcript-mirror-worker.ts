/**
 * The worker that mirrors one conversation's checkpoint into its transcript files.
 *
 * It is given the checkpoint blob and the databases that hold the state it points at, and it reads them read-only: a
 * blob that is not there, a message that cannot be read or a checkpoint that is missing is answered as an error rather
 * than guessed at, and it never writes a blob.
 */
import { existsSync } from "node:fs";
import { DatabaseSync, type StatementSync } from "node:sqlite";
import { parentPort } from "node:worker_threads";

import { createContext } from "../../../packages/context/context.ts";
import { ConversationStateStructure } from "../../../packages/proto/generated/agent/v1/agent_pb.ts";
import { invariant } from "../../../shared/invariant.ts";
import { LegacyFileTranscriptMirror } from "../../transcript/mirror/legacy-transcript-mirror.ts";

interface ReadConnection {
  readonly db: DatabaseSync;
  readonly statement: StatementSync;
}

const openConnections = new Map<string, ReadConnection>();
const reportedOpenFailures = new Set<string>();

export interface TranscriptMirrorWorkerRequest {
  readonly kind: string;
  readonly requestId: number;
  readonly conversationId: string;
  readonly stateBlobId: Uint8Array;
  readonly blobDbPaths: string[];
  readonly transcriptsDir: string;
}

function blobIdToHex(blobIdentifier: Uint8Array): string {
  return Buffer.from(
    blobIdentifier.buffer,
    blobIdentifier.byteOffset,
    blobIdentifier.byteLength
  ).toString("hex");
}

function openBlobConnection(dbPath: string): ReadConnection | null {
  const cachedConnection = openConnections.get(dbPath);
  if (cachedConnection != null) return cachedConnection;
  if (!existsSync(dbPath)) return null;
  try {
    const db = new DatabaseSync(dbPath, { readOnly: true });
    db.exec("PRAGMA busy_timeout = 5000");
    const readConnection = {
      db,
      statement: db.prepare("SELECT data FROM blobs WHERE id = ?")
    };
    openConnections.set(dbPath, readConnection);
    return readConnection;
  } catch (failure) {
    if (!reportedOpenFailures.has(dbPath)) {
      reportedOpenFailures.add(dbPath);
      console.error(
        `[transcript-mirror-worker] cannot open ${dbPath} read-only:`,
        failure
      );
    }
    return null;
  }
}

export class ReadOnlySqliteBlobStore {
  constructor(readonly dbPaths: readonly string[]) {}

  async getBlob(
    _ctx: unknown,
    blobIdentifier: Uint8Array
  ): Promise<Uint8Array | undefined> {
    const blobKey = blobIdToHex(blobIdentifier);
    for (const dbPath of this.dbPaths) {
      const readConnection = openBlobConnection(dbPath);
      if (readConnection == null) continue;
      try {
        const blobRow = readConnection.statement.get(blobKey) as
          | { data?: unknown }
          | undefined;
        if (blobRow?.data instanceof Uint8Array) return blobRow.data;
      } catch (failure) {
        console.error(
          `[transcript-mirror-worker] blob read failed in ${dbPath}:`,
          failure
        );
      }
    }
    return undefined;
  }

  async setBlob(): Promise<never> {
    invariant(false, "transcript-mirror worker never writes blobs");
  }

  async setBlobLocallyOnly(): Promise<never> {
    invariant(false, "transcript-mirror worker never writes blobs");
  }

  async flush(): Promise<void> {}
}

export class MissingTranscriptStateError extends Error {}

function postToParent(workerMessage: object): void {
  parentPort?.postMessage(workerMessage);
}

export function runTranscriptMirrorWorker(): void {
  const workerPort = parentPort;
  if (workerPort == null) {
    throw new Error("transcript-mirror-worker must run as a worker_thread");
  }
  workerPort.on("message", (workerRequest: TranscriptMirrorWorkerRequest) => {
    if (workerRequest.kind === "close") {
      postToParent({ kind: "close-ok", requestId: workerRequest.requestId });
      workerPort.close();
      return;
    }
    void (async () => {
      try {
        const startedAtMs = performance.now();
        const readOnlyStore = new ReadOnlySqliteBlobStore(workerRequest.blobDbPaths);
        const stateBytes = await readOnlyStore.getBlob(
          createContext(),
          workerRequest.stateBlobId
        );
        if (stateBytes == null) {
          throw new MissingTranscriptStateError(
            "transcript mirror checkpoint blob is unavailable"
          );
        }
        const state = ConversationStateStructure.fromBinary(stateBytes);
        const written = await new LegacyFileTranscriptMirror(
          workerRequest.transcriptsDir
        ).writeFull(
          createContext(),
          workerRequest.conversationId,
          state,
          readOnlyStore
        );
        postToParent({
          kind: "mirror-write-ok",
          requestId: workerRequest.requestId,
          written,
          durationMs: performance.now() - startedAtMs
        });
      } catch (failure) {
        postToParent({
          kind: "error",
          requestId: workerRequest.requestId,
          message: failure instanceof Error ? failure.message : String(failure)
        });
      }
    })();
  });
}

if (parentPort != null) runTranscriptMirrorWorker();
