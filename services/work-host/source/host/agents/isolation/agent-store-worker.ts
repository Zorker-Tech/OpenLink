/** The worker that owns one conversation's blobs.

 * The blob store cannot be shared across threads, so it lives in a worker of its own: requests arrive as messages, each
 * one is answered with what it produced, and a store that cannot be opened at all is reported and ends the worker. */
import { parentPort, threadId, workerData } from "node:worker_threads";

import { ConversationBlobRecoveryError } from "./conversation-blob-db.ts";
import { ConversationBlobStoreDb } from "./conversation-blob-store.ts";
import {
  isAgentStoreWorkerOperation,
  parseAgentStoreWorkerBoot,
  parseAgentStoreWorkerCommand,
} from "./agent-worker-protocol.ts";
import type { AgentStoreWorkerReply } from "./agent-worker-protocol.ts";

function emit(payload: AgentStoreWorkerReply, transfers: ArrayBuffer[] = []): void {
  parentPort?.postMessage(payload, transfers);
}

export function runAgentStoreWorker(): void {
  const workerPort = parentPort;
  if (workerPort == null) {
    throw new Error("agent-store-worker must run as a worker_thread");
  }

  const workerConfig = parseAgentStoreWorkerBoot(workerData);
  if (workerConfig == null) {
    console.error("[agent-isolation-worker] invalid worker bootstrap");
    process.exit(1);
    return;
  }
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

  workerPort.on("message", (message: unknown) => {
    const request = parseAgentStoreWorkerCommand(message);
    if (request == null) {
      const operation = typeof message === "object" && message !== null && "operation" in message
        ? (message as { readonly operation?: unknown }).operation
        : undefined;
      // The private protocol has historically ignored unknown operations while keeping this worker available.
      if (!isAgentStoreWorkerOperation(operation)) return;
      const callId = typeof message === "object" && message !== null && "callId" in message
        ? (message as { readonly callId?: unknown }).callId
        : undefined;
      if (Number.isSafeInteger(callId) && (callId as number) > 0) {
        const invalidBlobId = operation === "blob.write" && typeof message === "object" && message !== null &&
          "blobId" in message && !((message as { readonly blobId?: unknown }).blobId instanceof Uint8Array);
        const invalidBlobBytes = operation === "blob.write" && typeof message === "object" && message !== null &&
          "blobBytes" in message && !((message as { readonly blobBytes?: unknown }).blobBytes instanceof Uint8Array);
        emit({
          outcome: "failure",
          callId: callId as number,
          message: invalidBlobBytes ? "Invalid blob payload for BLOB column" : "Invalid agent-store worker command",
          name: invalidBlobBytes && !invalidBlobId ? "Error" : "TypeError",
          ...(invalidBlobId || invalidBlobBytes ? { code: "ERR_INVALID_ARG_TYPE" } : {}),
        });
      } else {
        workerPort.close();
      }
      return;
    }
    try {
      switch (request.operation) {
        case "worker.identify": {
          emit({
            outcome: "success",
            operation: request.operation,
            callId: request.callId,
            workerThreadId: threadId,
            processId: process.pid,
          });
          return;
        }
        case "blob.write": {
          if (request.blobBytes.byteLength === 0) throw new TypeError("Conversation blob data must not be empty");
          blobStore.setBlob(request.blobId, request.blobBytes);
          emit({ outcome: "success", operation: request.operation, callId: request.callId });
          return;
        }
        case "blob.read": {
          const blobData = blobStore.getBlob(request.blobId);
          if (blobData == null) {
            emit({
              outcome: "success",
              operation: request.operation,
              callId: request.callId,
              blobBytes: undefined,
            });
            return;
          }
          const snapshot = new Uint8Array(blobData.byteLength);
          snapshot.set(blobData);
          emit(
            {
              outcome: "success",
              operation: request.operation,
              callId: request.callId,
              blobBytes: snapshot,
            },
            [snapshot.buffer]
          );
          return;
        }
        case "root.find-latest": {
          emit({
            outcome: "success",
            operation: request.operation,
            callId: request.callId,
            latestRootId: blobStore.findLatestRootBlobId(),
          });
          return;
        }
        case "blob.clear": {
          blobStore.clearBlobs();
          emit({ outcome: "success", operation: request.operation, callId: request.callId });
          return;
        }
        case "checkpoint.prune": {
          emit({
            outcome: "success",
            operation: request.operation,
            callId: request.callId,
            deletedCount: blobStore.clearStaleCheckpointRoots(request.retainedRootIdHex),
          });
          return;
        }
        case "conversation.collect-garbage": {
          emit({
            outcome: "success",
            operation: request.operation,
            callId: request.callId,
            garbageReport: blobStore.collectGarbage({
              retainedRootIdHex: request.retainedRootIdHex,
              pendingWriteRetentionMs: request.pendingWriteRetentionMs,
            }),
          });
          return;
        }
        case "legacy.verify-retirement": {
          emit({
            outcome: "success",
            operation: request.operation,
            callId: request.callId,
            retirementVerdict: blobStore.verifyLegacyBlobRetirement(
              request.retainedRootIdHex,
              request.legacyBlobDbPath,
            ),
          });
          return;
        }
        case "store.flush": {
          emit({ outcome: "success", operation: request.operation, callId: request.callId });
          return;
        }
        case "worker.close": {
          blobStore.close();
          emit({ outcome: "success", operation: request.operation, callId: request.callId });
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
        outcome: "failure",
        callId: request.callId,
        message: cause instanceof Error ? cause.message : String(cause),
        ...(cause instanceof Error ? { name: cause.name } : {}),
        ...(failureCode == null ? {} : { code: failureCode })
      });
    }
  });
}

if (parentPort != null) runAgentStoreWorker();
