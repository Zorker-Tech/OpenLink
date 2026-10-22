import assert from "node:assert/strict";
import { describe, it } from "node:test";

import {
  collectPrependUserMessages,
  createShellWatchGeneratedStateProjection,
  createShellWatchReadAccessor,
  findConfirmedUserTurnWatermark,
  pollShellTerminalFile,
  readShellTerminalSnapshot,
  turnRefsEqual,
} from "../../source/host/runner/shell-terminal-watch.ts";
import { UserMessage } from "../../source/packages/proto/generated/agent/v1/agent_pb.ts";
import { SlateLocalToolPermissionDeniedError } from "../../source/shared/local-tool-permission-machinery.ts";

const contentWith = (footer: string) => "some output\n---\n" + footer + "\n---";
const readResult = (result: any) => ({ result } as never);
const captured = { read: async () => readResult({ case: "fileNotFound" }) } as never;

describe("reading a terminal file", () => {
  it("turns the three read answers into existence and content", async () => {
    assert.deepEqual(await readShellTerminalSnapshot({} as never, { read: async () => readResult({ case: "success", value: { output: { case: "content", value: "hello" } } }) } as never, "/terms/x.txt", "CTX"), { exists: true, content: "hello" });
    assert.deepEqual(await readShellTerminalSnapshot({} as never, { read: async () => readResult({ case: "success", value: { output: { case: "data", value: new Uint8Array([104, 105]) } } }) } as never, "/terms/x.txt", "CTX"), { exists: true, content: "hi" });
    assert.deepEqual(await readShellTerminalSnapshot({} as never, captured, "/terms/x.txt", "CTX"), { exists: false, content: "" });
    await assert.rejects(readShellTerminalSnapshot({} as never, { read: async () => readResult({ case: "permissionDenied" }) } as never, "/terms/x.txt", "CTX"), { name: "Error", message: "terminal file read failed (permissionDenied)" });
  });

  it("passes the read on with the empty call id", async () => {
    const seen: any[] = [];
    const accessor = createShellWatchReadAccessor({ get: () => ({ execute: async (_ctx: any, args: any) => { seen.push(args); return readResult({ case: "fileNotFound" }); } }) } as never);
    await accessor.read("CTX", { path: "/terms/x.txt", toolCallId: "call-1" });
    assert.deepEqual(seen.map((args) => [args.path, args.toolCallId]), [["/terms/x.txt", "call-1"]]);
  });

  it("binds the generated state and blobs to the decoders", async () => {
    const state = { turns: [] };
    const projection = createShellWatchGeneratedStateProjection({ getConversationState: () => state as never, getBlobStore: () => ({ getBlob: async () => null }) as never });
    assert.equal((projection.getConversationState as any)(), state);
    assert.equal(await projection.getBlob("CTX", new Uint8Array([1])), null);
    assert.deepEqual(projection.decodeUserMessage(new UserMessage({ text: "hi", messageId: "m1" }).toBinary()), { text: "hi", messageId: "m1" });
  });
});

describe("polling until the command ends", () => {
  function pollHost(options: any = {}) {
    let nowMs = 0;
    const reads: string[] = [];
    const host: any = {
      ctx: { with: () => ({ scoped: true }) },
      getConversationId: () => "agent-1",
      ensureBoxReady: async () => ({ terminalsFolder: "/terminals", remoteAccessor: { read: async (_ctx: any, args: any) => {
        reads.push(args.path);
        if (options.readThrows) throw options.readThrows;
        const answer = typeof options.content === "function" ? options.content(reads.length) : options.content ?? contentWith("exit_code: 0");
        if (answer === "missing") return readResult({ case: "fileNotFound" });
        return readResult({ case: "success", value: { output: { case: "content", value: answer } } });
      } } }),
      now: () => nowMs,
      delay: async () => { nowMs += options.advance ?? 1_000; },
    };
    return { host, reads };
  }
  async function poll(options: any = {}) {
    const { host, reads } = pollHost(options);
    const settles: any[] = [];
    await pollShellTerminalFile(host, "shell-1", () => options.cancelled === true, (status, detail, outputPath) => settles.push({ status, detail, outputPath }));
    return { settles, reads };
  }

  it("reports the exit status once the footer is complete", async () => {
    assert.deepEqual(await poll(), { settles: [{ status: "success", detail: undefined, outputPath: "/terminals/shell-1.txt" }], reads: ["/terminals/shell-1.txt"] });
    assert.deepEqual((await poll({ content: contentWith("exit_code: 2") })).settles, [{ status: "error", detail: "exit_code=2", outputPath: "/terminals/shell-1.txt" }]);
    assert.deepEqual((await poll({ content: contentWith("error: stream broke\nended_at: 2025-01-01T00:00:00Z") })).settles, [{ status: "error", detail: "the command's output stream failed; read its output file for the error", outputPath: "/terminals/shell-1.txt" }]);
    assert.deepEqual((await poll({ content: contentWith("exit_code: not-a-number") })).settles, [{ status: "error", detail: "exit_code=unknown", outputPath: "/terminals/shell-1.txt" }]);
  });

  it("gives up after the file stays missing, and reports a missing permission", async () => {
    const missing = await poll({ content: "missing" });
    assert.equal(missing.settles.length, 1);
    assert.match(missing.settles[0].detail, /no longer exists/);
    assert.equal(missing.reads.length, 5);
    const denied = await poll({ readThrows: new SlateLocalToolPermissionDeniedError("denied") });
    assert.match(denied.settles[0].detail, /no longer allowed to read/);
    assert.equal((await poll({ cancelled: true })).settles.length, 0);
  });
});

describe("knowing the confirmed user turn", () => {
  function watermarkedHost(cache: any, blobs: Record<number, Uint8Array>) {
    return {
      ctx: "CTX",
      getConfirmedUserTurnWatermarkCache: () => cache,
      setConfirmedUserTurnWatermarkCache: () => undefined,
      getBlob: async (_ctx: any, ref: Uint8Array) => blobs[ref[0] ?? -1] ?? null,
      decodeConversationTurn: (bytes: Uint8Array) => ({ turn: { case: "agentConversationTurn", value: { userMessage: bytes } } }) as never,
      decodeUserMessage: (bytes: Uint8Array) => ({ text: Buffer.from(bytes).toString("utf8").split("|")[0]!, messageId: Buffer.from(bytes).toString("utf8").split("|")[1]! }),
    };
  }

  it("skips hidden prompts and reuses a cache that still matches", async () => {
    const hiddenMessage = new Uint8Array(Buffer.from("[SLATE_HIDDEN_PROMPT]|"));
    const hidden = watermarkedHost(undefined, { 0: hiddenMessage, [hiddenMessage[0]!]: hiddenMessage });
    assert.deepEqual(await findConfirmedUserTurnWatermark(hidden as never, { turns: [new Uint8Array([0])] }), { hasUserTurn: false });
    const cached = watermarkedHost({ turnCount: 1, boundaryRef: new Uint8Array([1]), lastUserMessageId: "m0", hasUserTurn: true }, {});
    assert.deepEqual(await findConfirmedUserTurnWatermark(cached as never, { turns: [new Uint8Array([1])] }), { lastUserMessageId: "m0", hasUserTurn: true }, "the cached answer is reused");
    const freshMessage = new Uint8Array(Buffer.from("hello|m1"));
    const fresh = watermarkedHost(undefined, { 0: freshMessage, [freshMessage[0]!]: freshMessage });
    assert.deepEqual(await findConfirmedUserTurnWatermark(fresh as never, { turns: [new Uint8Array([0])] }), { lastUserMessageId: "m1", hasUserTurn: true });
  });

  it("prepends only the unconfirmed messages, with their address note", async () => {
    const host: any = {
      ctx: "CTX",
      getConversationState: () => ({ turns: [] }),
      getConfirmedUserTurnWatermarkCache: () => undefined,
      setConfirmedUserTurnWatermarkCache: () => undefined,
      getBlob: async () => null,
      decodeConversationTurn: () => ({ turn: { case: "otherTurn" } }),
      decodeUserMessage: () => ({ text: "", messageId: "" }),
    };
    const messages = await collectPrependUserMessages(host, [{ id: "m1", text: "first" }, { id: "m2", text: "second", richText: "<b>second</b>" }], "m2");
    assert.deepEqual(messages.map((message) => message.messageId), ["m1"]);
    assert.equal(messages[0]?.text.includes("[m1]"), true, "the address note is prepended");
    assert.equal(messages[0]?.text.includes("first"), true);
    const withRichText = await collectPrependUserMessages(host, [{ id: "m4", text: "fourth", richText: "<b>fourth</b>" }, { id: "m5", text: "fifth" }], "m5");
    assert.equal((withRichText[0] as any)?.richText, "<b>fourth</b>", "the rich text travels with the message");
  });

  it("compares turn references byte by byte", () => {
    assert.equal(turnRefsEqual(new Uint8Array([1, 2]), new Uint8Array([1, 2])), true);
    assert.equal(turnRefsEqual(new Uint8Array([1]), new Uint8Array([1, 2])), false);
    assert.equal(turnRefsEqual(new Uint8Array([2]), new Uint8Array([1])), false);
  });
});