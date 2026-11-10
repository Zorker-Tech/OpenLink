import assert from "node:assert/strict";
import { describe, it } from "node:test";

import {
  adaptBcsAgentStoreRpcClient,
  type BcsAgentStoreRpcClient,
} from "../../source/adapters/interop/agent-store/bcs-agent-store-client-adapter.ts";
import {
  AbortAgentStoreMultipartWritesRequest,
  AgentStoreDeleteFileEntry,
  AgentStoreDeleteFileStatus,
  AgentStoreDirectoryListingMode,
  AgentStoreMultipartOperationFailureCode,
  AgentStoreSourceKind,
  AgentStoreWriteFileEntry,
  CompleteAgentStoreMultipartWritesRequest,
  DeleteAgentStoreFilesRequest,
  ListAgentStoreDirectoryRequest,
  MintAgentStoreTokenRequest,
  PresignAgentStoreReadsRequest,
  PresignAgentStoreWritesRequest,
} from "../../source/adapters/interop/proto/generated/aiserver/v1/background_composer_pb.ts";

describe("agent-store RPC adapter", () => {
  it("encodes Slate requests and projects service replies into Slate values", async () => {
    const requests: Record<string, unknown> = {};
    const rpc: BcsAgentStoreRpcClient = {
      async mintAgentStoreToken(request) {
        requests.mint = request;
        return { token: "token", expiresAtMs: "5000", storeIds: [], agentIds: ["agent-store"] };
      },
      async listAgentStoreDirectory(request) {
        requests.list = request;
        return {
          mode: AgentStoreDirectoryListingMode.COMPLETE_FLAT_STORE,
          files: [{ relPath: "a.txt", etag: '"E1"', sizeBytes: 12n, lastModifiedMs: 21n }],
          tombstones: [{ relPath: "gone.txt", tombstoneEtag: '"T1"', deletedAtMs: 22n }],
        };
      },
      async presignAgentStoreReads(request) {
        requests.reads = request;
        return { instructions: [{ relPath: "a.txt", url: "https://read", expiresAtMs: "7000" }] };
      },
      async presignAgentStoreWrites(request) {
        requests.writes = request;
        return { instructions: [{ relPath: "a.txt", url: "https://write", headers: { x: "y" }, expiresAtMs: "8000" }] };
      },
      async completeAgentStoreMultipartWrites(request) {
        requests.complete = request;
        return { results: [{ inputIndex: 0, relPath: "a.txt", outcome: { case: "failure", value: { code: AgentStoreMultipartOperationFailureCode.PRECONDITION_FAILED } } }] };
      },
      async abortAgentStoreMultipartWrites(request) {
        requests.abort = request;
        return { results: [{ inputIndex: 0, relPath: "a.txt", outcome: { case: "success", value: { alreadyFinished: true } } }] };
      },
      async deleteAgentStoreFiles(request) {
        requests.delete = request;
        return { results: [{ relPath: "a.txt", status: AgentStoreDeleteFileStatus.DELETED, tombstoneEtag: '"T2"' }] };
      },
    };
    const client = adaptBcsAgentStoreRpcClient(rpc);
    const context = {
      uploadId: "upload",
      storeId: "store",
      relPath: "a.txt",
      sizeBytes: 10,
      sha: "sha",
      expectedPartCount: 1,
      precondition: { case: "baseEtag", value: "base" } as const,
      sessionId: "session",
    };

    assert.deepEqual(await client.mintToken({ kind: "source", sourceKind: "team", sourceId: "team-1" }), { token: "token", expiresAtMs: 5_000, storeIds: ["agent-store"] });
    assert.ok(requests.mint instanceof MintAgentStoreTokenRequest);
    assert.deepEqual([(requests.mint as MintAgentStoreTokenRequest).source?.kind, (requests.mint as MintAgentStoreTokenRequest).source?.sourceId], [AgentStoreSourceKind.TEAM, "team-1"]);

    const listing = await client.listDirectory({ storeId: "store", relativePath: "", pageSize: 100, pageToken: "", preferCompleteFlatStore: true });
    assert.ok(requests.list instanceof ListAgentStoreDirectoryRequest);
    assert.deepEqual(listing, { kind: "complete", files: [{ relPath: "a.txt", etag: '"E1"', size: 12, serverMtimeMs: 21 }], tombstones: [{ relPath: "gone.txt", tombstoneEtag: '"T1"', deletedAtMs: 22 }] });

    assert.deepEqual(await client.presignReads({ storeId: "store", relPaths: ["a.txt"] }), [{ relPath: "a.txt", url: "https://read", expiresAtMs: 7_000 }]);
    assert.ok(requests.reads instanceof PresignAgentStoreReadsRequest);

    const writeInput = { relPath: "a.txt", sha: "sha", size: 10, baseEtag: '"BASE"' };
    assert.deepEqual(await client.presignWrites({ storeId: "store", files: [writeInput] }), [{ relPath: "a.txt", url: "https://write", headers: { x: "y" }, expiresAtMs: 8_000 }]);
    assert.ok(requests.writes instanceof PresignAgentStoreWritesRequest);
    assert.ok((requests.writes as PresignAgentStoreWritesRequest).files[0] instanceof AgentStoreWriteFileEntry);
    assert.equal((requests.writes as PresignAgentStoreWritesRequest).files[0]?.precondition?.value, "base");

    const completion = { context, parts: [{ partNumber: 1, etag: "part", checksumSha256: new Uint8Array([1]) }] };
    assert.deepEqual(await client.completeWrites({ storeId: "store", completions: [completion] }), [{ inputIndex: 0, relPath: "a.txt", outcome: { kind: "failure", code: "precondition_failed" } }]);
    assert.ok(requests.complete instanceof CompleteAgentStoreMultipartWritesRequest);
    assert.deepEqual(await client.abortWrites({ storeId: "store", uploads: [{ context }] }), [{ inputIndex: 0, relPath: "a.txt", outcome: { kind: "success", alreadyFinished: true } }]);
    assert.ok(requests.abort instanceof AbortAgentStoreMultipartWritesRequest);

    assert.deepEqual(await client.deleteFiles({ storeId: "store", files: [{ relPath: "a.txt", baseEtag: "base" }] }), [{ relPath: "a.txt", status: "deleted", tombstoneEtag: '"T2"' }]);
    assert.ok(requests.delete instanceof DeleteAgentStoreFilesRequest);
    assert.ok((requests.delete as DeleteAgentStoreFilesRequest).files[0] instanceof AgentStoreDeleteFileEntry);
  });
});
