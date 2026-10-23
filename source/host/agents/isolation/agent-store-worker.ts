/** The worker that owns one conversation's blobs.

 * The blob store cannot be shared across threads, so it lives in a worker of its own: requests arrive as messages, each
 * one is answered with what it produced, and a store that cannot be opened at all is reported and ends the worker. */
import { parentPort, threadId, workerData } from "node:worker_threads";

import { ConversationBlobRecoveryError } from "./conversation-blob-db.ts";
import { ConversationBlobStoreDb } from "./conversation-blob-store.ts";

interface AgentStoreWorkerBoot {
  readonly agentId: string;
  readonly blobDbPath: string;
  readonly busyTimeoutMs?: number;
  readonly legacyBlobDbPath?: string;
}

interface AgentStoreWorkerRequest {
  readonly kind: string;
  readonly requestId: number;
  readonly blobId?: Uint8Array;
  readonly blobData?: Uint8Array;
  readonly retainedRootIdHex?: string;
  readonly pendingWriteRetentionMs?: number;
  readonly legacyBlobDbPath?: string;
}

function emit(payload: object, transfers: ArrayBuffer[] = []): void {
  parentPort?.postMessage(payload, transfers);
}

export function runAgentStoreWorker(): void {
  const workerPort = parentPort;
  if (workerPort == null) {
    throw new Error("agent-store-worker must run as a worker_thread");
  }

  const workerConfig = workerData as AgentStoreWorkerBoot;
  let blobStore: ConversationBlobStoreDb;
  try {
    blobStore = new ConversationBlobStoreDb({
      agentId: workerConfig.agentId,
      blobDbPath: workerConfig.blobDbPath,
      busyTimeoutMs: workerConfig.busyTimeoutMs ?? 5_000,
      ...(workerConfig.legacyBlobDbPath == null
        ? {}
        : { legacyBlobDbPath: workerConfig.legacyBlobDbPath })
    });
  } catch (cause) {
    const failureCode = cause instanceof ConversationBlobRecoveryError
      ? cause.code
      : typeof cause === "object" &&
          cause !== null &&
          "code" in cause &&
          typeof cause.code === "string"
        ? cause.code
        : "error";
    const failureDetail = cause instanceof ConversationBlobRecoveryError
      ? ` detail=${cause.message}`
      : "";
    console.error(
      `[agent-store-worker] failed to open blob db: agent=${workerConfig.agentId} code=${failureCode}${failureDetail}`
    );
    process.exit(1);
    return;
  }

  workerPort.on("message", (incomingRequest: AgentStoreWorkerRequest) => {
    try {
      switch (incomingRequest.kind) {
        case "init": {
          emit({
            kind: "init-ok",
            requestId: incomingRequest.requestId,
            threadId,
            pid: process.pid
          });
          return;
        }
        case "set-blob": {
          blobStore.setBlob(incomingRequest.blobId as Uint8Array, incomingRequest.blobData as Uint8Array);
          emit({ kind: "set-blob-ok", requestId: incomingRequest.requestId });
          return;
        }
        case "get-blob": {
          const blobData = blobStore.getBlob(incomingRequest.blobId as Uint8Array);
          if (blobData == null) {
            emit({
              kind: "get-blob-ok",
              requestId: incomingRequest.requestId,
              blobData: undefined
            });
            return;
          }
          const snapshot = new Uint8Array(blobData.byteLength);
          snapshot.set(blobData);
          emit(
            {
              kind: "get-blob-ok",
              requestId: incomingRequest.requestId,
              blobData: snapshot
            },
            [snapshot.buffer]
          );
          return;
        }
        case "find-latest-root": {
          emit({
            kind: "find-latest-root-ok",
            requestId: incomingRequest.requestId,
            rootId: blobStore.findLatestRootBlobId()
          });
          return;
        }
        case "clear-blobs": {
          blobStore.clearBlobs();
          emit({ kind: "clear-blobs-ok", requestId: incomingRequest.requestId });
          return;
        }
        case "clear-stale-roots": {
          emit({
            kind: "clear-stale-roots-ok",
            requestId: incomingRequest.requestId,
            deleted: blobStore.clearStaleCheckpointRoots(
              incomingRequest.retainedRootIdHex as string
            )
          });
          return;
        }
        case "collect-garbage": {
          emit({
            kind: "collect-garbage-ok",
            requestId: incomingRequest.requestId,
            result: blobStore.collectGarbage({
              retainedRootIdHex: incomingRequest.retainedRootIdHex as string,
              pendingWriteRetentionMs: incomingRequest.pendingWriteRetentionMs as number
            })
          });
          return;
        }
        case "verify-legacy-blob-retirement": {
          emit({
            kind: "verify-legacy-blob-retirement-ok",
            requestId: incomingRequest.requestId,
            verdict: blobStore.verifyLegacyBlobRetirement(
              incomingRequest.retainedRootIdHex as string,
              incomingRequest.legacyBlobDbPath as string
            )
          });
          return;
        }
        case "flush": {
          emit({ kind: "flush-ok", requestId: incomingRequest.requestId });
          return;
        }
        case "close": {
          blobStore.close();
          emit({ kind: "close-ok", requestId: incomingRequest.requestId });
          workerPort.close();
          return;
        }
      }
    } catch (cause) {
      const failureCode = typeof cause === "object" &&
          cause !== null &&
          "code" in cause &&
          typeof cause.code === "string"
        ? cause.code
        : undefined;
      emit({
        kind: "error",
        requestId: incomingRequest.requestId,
        message: cause instanceof Error ? cause.message : String(cause),
        ...(cause instanceof Error ? { name: cause.name } : {}),
        ...(failureCode == null ? {} : { code: failureCode })
      });
    }
  });
}

if (parentPort != null) runAgentStoreWorker();
