import { test } from "node:test";
import assert from "node:assert/strict";

import { createContext } from "../../source/packages/context/context.ts";
import {
  createSessionMaintenanceHost,
  createSessionMaintenanceWorkerPort,
} from "../../source/host/extensions/session/session-production-maintenance.ts";

test("the production maintenance host projects worker and conversation ports", async () => {
  const calls: string[] = [];
  const worker = {
    async clearStaleCheckpointRoots() { calls.push("clear-stale"); return 2; },
    async findLatestRootBlobId() { calls.push("find-root"); return undefined; },
    async verifyLegacyBlobRetirement() { calls.push("verify-retirement"); return { isRetirable: true }; },
  };
  const context = createContext();
  const host = createSessionMaintenanceHost({
    rootDir: "/agents",
    context,
    worker: worker as never,
    conversationState: {
      async resolveConversationState(structure: unknown, blobStore: unknown) {
        calls.push("resolve-state");
        assert.equal(structure, "checkpoint");
        assert.equal(blobStore, "blobs");
        return {
          turns: [{
            turn: {
              case: "agentConversationTurn",
              value: {
                userMessage: { text: "hello", messageId: "message-1" },
                steps: [{ message: { case: "assistantMessage", value: { text: "answer" } } }],
              },
            },
          }],
        } as never;
      },
    },
  });

  assert.equal(host.rootDir, "/agents");
  assert.equal(host.ctx, context);
  assert.deepEqual(
    await host.resolveConversationState("checkpoint", "blobs"),
    {
      turns: [{
        turn: {
          case: "agentConversationTurn",
          value: {
            userMessage: { text: "hello", messageId: "message-1" },
            steps: [{ message: { case: "assistantMessage", value: { text: "answer" } } }],
          },
        },
      }],
    },
  );
  assert.deepEqual(host.deriveOutline?.({
    turns: [{
      turn: {
        case: "agentConversationTurn",
        value: {
          userMessage: { text: "hello", messageId: "message-1" },
          steps: [{ message: { case: "assistantMessage", value: { text: "answer" } } }],
        },
      },
    }],
  } as never), [{ kind: "user", id: "outline-user-0", text: "hello" }]);

  const workerPort = createSessionMaintenanceWorkerPort(worker as never);
  assert.equal(await workerPort.findLatestRootBlobId({
    agentId: "agent-1",
    blobDbPath: "/agents/agent-1/blobs.db",
    legacyBlobDbPath: "/agents/agent-1/store.db",
  }), null);
  assert.deepEqual(await workerPort.verifyLegacyBlobRetirement({
    agentId: "agent-1",
    blobDbPath: "/agents/agent-1/blobs.db",
    legacyBlobDbPath: "/agents/agent-1/store.db",
    retainedRootIdHex: "beef",
  }), { isRetirable: true });
  assert.deepEqual(calls, ["resolve-state", "find-root", "verify-retirement"]);
});
