/**
 * Converting the platform's prompt shapes into the inference protocol's, one path's worth of sync work,
 * and the outline of a conversation.
 */

import assert from "node:assert/strict";
import { describe, it } from "node:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { applyToolCallArgs, buildStreamRequest, coreMessageToProto, toolCallArgsFromProto } from "../../source/packages/chat-inference-proto/converters.ts";
import { ackPathSyncRequests, enqueuePathSyncRequest, listPathSyncRequests, PATH_SYNC_REQUEST_POLL_MS, PATH_SYNC_REQUEST_WAIT_POLL_MS, waitForPathSyncRequestAck } from "../../source/packages/agent-store-sync/path-sync-request.ts";
import { deriveOutlineFromConversationState, MAX_TOOL_ACTIVITY_ARGS_CHARS, MCP_TOOL_CALL_OUTLINE_NAME, SEND_MESSAGE_TOOL_CALL_OUTLINE_NAME } from "../../source/host/runner/conversation-outline.ts";

describe("converting to the inference protocol", () => {
  it("builds a stream request and converts a core message", () => {
    assert.equal(typeof buildStreamRequest, "function");
    assert.equal(typeof coreMessageToProto, "function");
    assert.equal(typeof applyToolCallArgs, "function");
    assert.equal(typeof toolCallArgsFromProto, "function");
  });
});

describe("one path's worth of sync work", () => {
  const pickRoot = (): string => {
    for (const candidate of [path.join("/Users", os.userInfo().username), os.tmpdir()]) {
      try {
        if (fs.realpathSync.native(candidate) !== candidate) continue;
        const root = fs.mkdtempSync(path.join(candidate, "slate-psr-test-"));
        if (fs.realpathSync.native(root) === root) return root;
        fs.rmSync(root, { recursive: true, force: true });
      } catch {}
    }
    throw new Error("no canonical directory for the path-sync tests");
  };
  const root = pickRoot();
  const filesDir = path.join(root, "store", "files");
  const requestsDir = path.join(path.dirname(path.resolve(filesDir)), ".sync", "path-sync-requests");
  const reset = (): void => {
    fs.rmSync(root, { recursive: true, force: true });
    fs.mkdirSync(filesDir, { recursive: true });
  };
  const now = 1_000_000;

  it("names the two poll intervals, and offers the queue", () => {
    assert.equal(PATH_SYNC_REQUEST_POLL_MS, 250);
    assert.equal(PATH_SYNC_REQUEST_WAIT_POLL_MS, 50);
    assert.equal(typeof enqueuePathSyncRequest, "function");
    assert.equal(typeof listPathSyncRequests, "function");
  });

  it("writes a request under the store's sync directory, with the paths deduplicated and the given time", async () => {
    reset();
    const id = await enqueuePathSyncRequest({ filesDir, relPaths: ["a/b.txt", "c.txt", "a/b.txt"], now: () => now });
    assert.equal(typeof id, "string");
    assert.match(id ?? "", /^[0-9a-f]{32}$/);
    const file = path.join(requestsDir, id + ".json");
    assert.equal(fs.existsSync(file), true);
    const raw = fs.readFileSync(file, "utf8");
    assert.equal(raw.endsWith("\n"), true);
    const body = JSON.parse(raw) as { v: number; id: string; relPaths: string[]; createdAtMs: number };
    assert.deepEqual(body, { v: 1, id, relPaths: ["a/b.txt", "c.txt"], createdAtMs: now });
    assert.equal((fs.statSync(file).mode & 0o777).toString(8), "600");
    assert.deepEqual(listPathSyncRequests({ filesDir, now: () => now }).map((request) => request.relPaths), [["a/b.txt", "c.txt"]]);
  });

  it("refuses paths that cannot be synchronised, and paths mixed with them", async () => {
    reset();
    assert.equal(await enqueuePathSyncRequest({ filesDir, relPaths: [], now: () => now }), undefined);
    assert.equal(await enqueuePathSyncRequest({ filesDir, relPaths: ["/absolute.txt"], now: () => now }), undefined);
    assert.equal(await enqueuePathSyncRequest({ filesDir, relPaths: ["../escape.txt"], now: () => now }), undefined);
    assert.equal(await enqueuePathSyncRequest({ filesDir, relPaths: ["good.txt", 42], now: () => now }), undefined);
  });

  it("lists only requests it can still read, removing the rest", () => {
    reset();
    fs.mkdirSync(requestsDir, { recursive: true });
    const good = { v: 1, id: "aa".repeat(16), relPaths: ["good.txt"], createdAtMs: now - 1_000 };
    fs.writeFileSync(path.join(requestsDir, good.id + ".json"), JSON.stringify(good));
    fs.writeFileSync(path.join(requestsDir, "notes.txt"), "not a request");
    fs.writeFileSync(path.join(requestsDir, "backup.json.bak"), "{}");
    fs.writeFileSync(path.join(requestsDir, "broken.json"), "{not json");
    fs.writeFileSync(path.join(requestsDir, "oldversion.json"), JSON.stringify({ v: 2, id: "bb".repeat(16), relPaths: ["x"], createdAtMs: now }));
    fs.writeFileSync(path.join(requestsDir, "stale.json"), JSON.stringify({ v: 1, id: "cc".repeat(16), relPaths: ["y"], createdAtMs: now - 120_000 }));
    fs.writeFileSync(path.join(requestsDir, "boundary.json"), JSON.stringify({ v: 1, id: "dd".repeat(16), relPaths: ["z"], createdAtMs: now - 60_000 }));
    fs.writeFileSync(path.join(requestsDir, "badtime.json"), `{"v":1,"id":"${"ee".repeat(16)}","relPaths":["w"],"createdAtMs":1e999}`);
    fs.writeFileSync(path.join(requestsDir, "emptyid.json"), JSON.stringify({ v: 1, id: "", relPaths: ["v"], createdAtMs: now }));
    fs.mkdirSync(path.join(requestsDir, "directory.json"));
    const unreadable = path.join(requestsDir, "unreadable.json");
    fs.writeFileSync(unreadable, JSON.stringify({ v: 1, id: "ff".repeat(16), relPaths: ["q"], createdAtMs: now }));
    fs.chmodSync(unreadable, 0o000);
    const target = path.join(root, "symlink-target.json");
    fs.writeFileSync(target, JSON.stringify(good));
    fs.symlinkSync(target, path.join(requestsDir, "link.json"));

    const listed = listPathSyncRequests({ filesDir, now: () => now });
    assert.deepEqual(listed.map((request) => request.relPaths).sort(), [["good.txt"], ["z"]].sort());
    assert.deepEqual(fs.readdirSync(requestsDir).sort(), ["aa".repeat(16) + ".json", "backup.json.bak", "boundary.json", "directory.json", "notes.txt", "unreadable.json"].sort());
  });

  it("acknowledges an id only when it is a request id", () => {
    reset();
    fs.mkdirSync(requestsDir, { recursive: true });
    const id = "ab".repeat(16);
    fs.writeFileSync(path.join(requestsDir, id + ".json"), "{}");
    fs.writeFileSync(path.join(requestsDir, "a.json"), "{}");
    fs.writeFileSync(path.join(requestsDir, "aa-bb.json"), "{}");
    ackPathSyncRequests({ filesDir, requestIds: [id, "not-an-id", "aa-bb"] });
    assert.deepEqual(fs.readdirSync(requestsDir).sort(), ["a.json", "aa-bb.json"]);
  });

  it("waits for an ack, a stale request, or an abort, in that order", async () => {
    reset();
    fs.mkdirSync(requestsDir, { recursive: true });
    const id = "cd".repeat(16);
    const file = path.join(requestsDir, id + ".json");
    const writeRequest = (createdAtMs: number): void => {
      fs.writeFileSync(file, JSON.stringify({ v: 1, id, relPaths: ["x"], createdAtMs }));
    };

    assert.equal(await waitForPathSyncRequestAck({ filesDir, requestId: id, now: () => now }), "acked");
    writeRequest(now - 120_000);
    assert.equal(await waitForPathSyncRequestAck({ filesDir, requestId: id, now: () => now }), "stale");
    writeRequest(now - 120_000);
    assert.equal(await waitForPathSyncRequestAck({ filesDir, requestId: id, now: () => now, shouldAbort: () => true }), "stale", "a stale request is answered before the abort is considered");
    writeRequest(now);
    assert.equal(await waitForPathSyncRequestAck({ filesDir, requestId: id, now: () => now, shouldAbort: () => true }), "aborted");
    fs.writeFileSync(file, "{broken json");
    assert.equal(await waitForPathSyncRequestAck({ filesDir, requestId: id, now: () => now }), "stale");

    writeRequest(now);
    const delays: number[] = [];
    assert.equal(
      await waitForPathSyncRequestAck({
        filesDir,
        requestId: id,
        pollMs: 7,
        now: () => now,
        delay: async (ms) => { delays.push(ms); fs.rmSync(file, { force: true }); },
      }),
      "acked",
    );
    assert.deepEqual(delays, [7], "the caller's poll interval is used");
  });
});

describe("the outline of a conversation", () => {
  it("names the tool calls a reader can jump to and bounds what a call may carry", () => {
    assert.equal(SEND_MESSAGE_TOOL_CALL_OUTLINE_NAME, "sendMessageToolCall");
    assert.equal(MCP_TOOL_CALL_OUTLINE_NAME, "mcpToolCall");
    assert.equal(MAX_TOOL_ACTIVITY_ARGS_CHARS, 20_000);
    assert.equal(typeof deriveOutlineFromConversationState, "function");
  });
});