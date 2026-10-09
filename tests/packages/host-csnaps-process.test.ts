/**
 * The codebase-telemetry helper as the host sees it: one frame per request, answers handed to the request that
 * asked, a helper that died or answered nonsense reported as the process's own terminal failure, and stopping it by
 * asking it to shut down first.
 */

import assert from "node:assert/strict";
import { chmodSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PassThrough } from "node:stream";
import { after, describe, it } from "node:test";

import { CsnapsProcess, CsnapsProcessError, CsnapsRequestError, describeCsnapsExit, writeFrame } from "../../source/host/extensions/codebase-telemetry/csnaps-process.ts";
import { CsnapsProtocolError, decodeFramePayloads, encodeFrame } from "../../source/host/extensions/codebase-telemetry/csnaps-protocol.ts";
import { DeadlineExceededError, type DeadlinePolicy } from "../../source/host/extensions/scheduling.ts";

const scratch = mkdtempSync(join(tmpdir(), "slate-csnaps-process-"));
after(() => { rmSync(scratch, { recursive: true, force: true }); });

const tick = () => new Promise((resolve) => setImmediate(resolve));

/** A helper process that is only pipes and a kill switch. */
function fakeHelper() {
  const stdin = new PassThrough();
  const stdout = new PassThrough();
  const listeners = new Map<string, ((...args: unknown[]) => void)[]>();
  const killed: string[] = [];
  const child = {
    stdin,
    stdout,
    exitCode: null as number | null,
    signalCode: null as string | null,
    once(event: string, listener: (...args: unknown[]) => void) {
      listeners.set(event, [...(listeners.get(event) ?? []), listener]);
      return child;
    },
    on(event: string, listener: (...args: unknown[]) => void) {
      listeners.set(event, [...(listeners.get(event) ?? []), listener]);
      return child;
    },
    kill(signal: string) {
      killed.push(signal);
      return true;
    },
    emit(event: string, ...args: unknown[]) {
      for (const listener of listeners.get(event) ?? []) listener(...args);
    },
  };
  return { child, stdin, stdout, killed, emit: child.emit };
}

/** Deadline policies that expire only when the test says so, and that honour the caller's own signal. */
function deadlineHarness() {
  const controllers = new Map<string, AbortController>();
  const deadline = (name: string): DeadlinePolicy => ({
    name,
    async run<T>(work: (signal: AbortSignal) => Promise<T>, caller?: AbortSignal): Promise<T> {
      const controller = new AbortController();
      controllers.set(name, controller);
      if (caller?.aborted) controller.abort(caller.reason);
      else caller?.addEventListener("abort", () => controller.abort(caller.reason), { once: true });
      if (controller.signal.aborted) throw controller.signal.reason;
      try {
        // The work runs under the deadline: whoever expires it decides the request's fate, just as the real policy does.
        return await new Promise<T>((resolve, reject) => {
          controller.signal.addEventListener("abort", () => reject(controller.signal.reason), { once: true });
          work(controller.signal).then(resolve, reject);
        });
      } finally {
        if (controllers.get(name) === controller) controllers.delete(name);
      }
    },
  });
  return { deadline, controllers };
}

function helperWorld() {
  const helper = fakeHelper();
  const harness = deadlineHarness();
  const deadlines = {
    ping: harness.deadline("csnaps-ping"),
    initialize: harness.deadline("csnaps-initialize"),
    applyCodebaseSpecs: harness.deadline("csnaps-apply-codebase-specs"),
    snapshot: harness.deadline("csnaps-snapshot"),
    triggerUpload: harness.deadline("csnaps-trigger-upload"),
    flushPendingUploads: harness.deadline("csnaps-flush-pending-uploads"),
    shutdown: harness.deadline("csnaps-shutdown"),
    exit: harness.deadline("csnaps-exit"),
  };
  const process = new CsnapsProcess(helper.child as never, deadlines);
  const written: Buffer[] = [];
  helper.stdin.on("data", (chunk: Buffer) => void written.push(chunk));
  const requests = () => decodeFramePayloads(Buffer.concat(written)).payloads.map((payload) => JSON.parse(payload.toString("utf8")) as { id: number; method: string; params: Record<string, unknown> });
  const answer = (body: unknown) => void helper.stdout.write(encodeFrame(Buffer.from(JSON.stringify(body), "utf8")));
  return { process, helper, harness, requests, answer };
}

const settle = (promise: Promise<unknown>) => promise.then(() => "resolved" as const, (error: unknown) => error);

describe("talking to the helper over its pipes", () => {
  it("sends one numbered frame per request and hands each answer to the request that asked", async () => {
    const world = helperWorld();
    const first = world.process.ping();
    const second = world.process.snapshot({ type: "AGENT_REQUEST_START", requestId: "r-1" });
    await tick();
    assert.deepEqual(world.requests(), [
      { id: 0, method: "ping", params: {} },
      { id: 1, method: "snapshot", params: { reason: { type: "AGENT_REQUEST_START", requestId: "r-1" } } },
    ]);
    // The answer to the second one resolves the second one, and leaves the first waiting.
    let firstSettled = false;
    void first.then(() => void (firstSettled = true));
    world.answer({ id: 1, ok: true, result: {} });
    assert.equal(await settle(second), "resolved");
    assert.equal(firstSettled, false);
    world.answer({ id: 0, ok: true, result: {} });
    assert.equal(await settle(first), "resolved");
    // An answer that arrived in two pieces is still one answer.
    const third = world.process.ping();
    await tick();
    const frame = encodeFrame(Buffer.from('{"id":2,"ok":true,"result":{}}'));
    world.helper.stdout.write(frame.subarray(0, 3));
    assert.equal(firstSettled, true);
    world.helper.stdout.write(frame.subarray(3));
    assert.equal(await settle(third), "resolved");
  });

  it("fails the request when the helper refuses it, naming the method and the code", async () => {
    const world = helperWorld();
    const call = world.process.snapshot("reason");
    await tick();
    world.answer({ id: 0, ok: false, error: "server_busy" });
    const failure = await settle(call);
    assert.equal(failure instanceof CsnapsRequestError, true);
    assert.deepEqual([(failure as CsnapsRequestError).method, (failure as CsnapsRequestError).code, (failure as CsnapsRequestError).message], ["snapshot", "server_busy", "csnaps snapshot request failed: server_busy"]);
  });

  it("answers each operation out of the result the protocol defines for it", async () => {
    const world = helperWorld();
    const initialized = world.process.initialize({ root: "/workspace" });
    await tick();
    assert.deepEqual(world.requests().map((request) => request.method), ["initialize"]);
    world.answer({ id: 0, ok: true, result: { state: { tracked: [] } } });
    assert.deepEqual(await initialized, { state: { tracked: [] } });
    const applied = world.process.applyCodebaseSpecs([{ path: "/workspace", kind: 1 }]);
    await tick();
    world.answer({ id: 1, ok: true, result: { state: { tracked: [] }, rejected: [{ path: "/home/box", kind: 3 }] } });
    assert.deepEqual(await applied, { state: { tracked: [] }, rejected: [{ path: "/home/box", kind: 3 }] });
    // An answer that does not hold what the operation promised is a protocol failure, not a result — and one bad
    // answer does not end the process: the request that made it is the one that suffers.
    const nonsense = world.process.triggerUpload({ token: "upload-1" });
    await tick();
    world.answer({ id: 2, ok: true, result: { unexpected: true } });
    const refused = await settle(nonsense);
    assert.equal(refused instanceof CsnapsProtocolError, true);
    assert.equal((refused as Error).message, "invalid empty csnaps result");
    let terminated = false;
    void world.process.terminalFailure.then(() => void (terminated = true));
    await tick();
    assert.equal(terminated, false);
  });
});

describe("a helper that went wrong", () => {
  it("fails terminally on an answer nobody asked for, and refuses to send anything more", async () => {
    const world = helperWorld();
    const call = world.process.ping();
    await tick();
    world.answer({ id: 7, ok: true, result: {} });
    const failure = await world.process.terminalFailure;
    assert.equal(failure.message, "csnaps returned an unknown request ID");
    assert.equal(await settle(call), failure);
    assert.deepEqual(world.helper.killed, ["SIGTERM"]);
    // Nothing more is written, and a request made after the failure is refused at once.
    const before = world.requests().length;
    assert.equal(await settle(world.process.ping()), failure);
    await tick();
    assert.equal(world.requests().length, before);
    // An answer nobody asked for spoils the whole read: the request that was answered alongside it is not told the
    // answer, because a helper that answers what it was not asked cannot be trusted about the rest.
    const mixed = helperWorld();
    const asked = mixed.process.ping();
    await tick();
    const good = encodeFrame(Buffer.from('{"id":0,"ok":true,"result":{}}', "utf8"));
    const stray = encodeFrame(Buffer.from('{"id":7,"ok":true,"result":{}}', "utf8"));
    mixed.helper.stdout.write(Buffer.concat([good, stray]));
    assert.equal(await settle(asked), await mixed.process.terminalFailure);
  });

  it("fails terminally when an answer is cut off, and when the helper exits without answering", async () => {
    const truncated = helperWorld();
    const call = truncated.process.snapshot("reason");
    await tick();
    const frame = encodeFrame(Buffer.from('{"id":0,"ok":true,"result":{}}'));
    truncated.helper.stdout.write(frame.subarray(0, 6));
    truncated.helper.emit("close", 0, null);
    const cut = await truncated.process.terminalFailure;
    assert.equal(cut.message, "truncated csnaps response frame");
    assert.equal(await settle(call), cut);
    const exited = helperWorld();
    const pending = exited.process.ping();
    await tick();
    exited.helper.emit("close", 3, null);
    const gone = await exited.process.terminalFailure;
    assert.equal(gone.message, "csnaps process exited with code 3");
    assert.equal(await settle(pending), gone);
  });

  it("fails the request that ran out of time, and a request the caller gave up on", async () => {
    const slow = helperWorld();
    const call = slow.process.ping();
    await tick();
    slow.harness.controllers.get("csnaps-ping")!.abort(new DeadlineExceededError("csnaps-ping"));
    const timedOut = await settle(call);
    assert.match((timedOut as Error).message, /csnaps ping request timed out/);
    assert.equal(await slow.process.terminalFailure, timedOut);
    const cancelled = helperWorld();
    const controller = new AbortController();
    const abandoned = cancelled.process.snapshot("reason", controller.signal);
    await tick();
    controller.abort(new Error("the turn ended"));
    const stopped = await settle(abandoned);
    assert.match((stopped as Error).message, /csnaps snapshot request cancelled/);
  });

  it("refuses a helper that answered the same request twice in one read", async () => {
    const world = helperWorld();
    const call = world.process.ping();
    await tick();
    // Both answers arrive together, which is where a doubled answer is a protocol failure rather than a late one.
    const answer = encodeFrame(Buffer.from(JSON.stringify({ id: 0, ok: true, result: {} }), "utf8"));
    world.helper.stdout.write(Buffer.concat([answer, answer]));
    const failure = await world.process.terminalFailure;
    assert.equal(failure.message, "csnaps returned a duplicate request ID");
    // The doubled answer is refused before either of them is handed over, so the request that asked waits no longer.
    assert.equal(await settle(call), failure);
  });
});

describe("stopping the helper", () => {
  it("asks it to shut down, and waits for it to be gone", async () => {
    const world = helperWorld();
    const closing = world.process.close();
    await tick();
    assert.deepEqual(world.requests().map((request) => request.method), ["shutdown"]);
    world.answer({ id: 0, ok: true, result: {} });
    let closed = false;
    void closing.then(() => void (closed = true));
    await tick();
    assert.equal(closed, false);
    world.helper.emit("close", 0, null);
    await closing;
    assert.equal(closed, true);
    // Closing twice is the same close.
    assert.equal(world.process.close(), closing);
    // A helper that left when it was asked to is not a helper that failed: its terminal failure is never handed on.
    let failed = false;
    void world.process.terminalFailure.then(() => void (failed = true));
    await tick();
    assert.equal(failed, false);
  });

  it("takes a helper down when it will not shut down, and reports one that never leaves", async () => {
    const refusing = helperWorld();
    const closing = refusing.process.close();
    await tick();
    refusing.answer({ id: 0, ok: false, error: "shutting_down" });
    await tick();
    assert.deepEqual(refusing.helper.killed, ["SIGTERM"]);
    refusing.helper.emit("close", null, "SIGTERM");
    await closing;
    // A helper that will not leave even when killed is reported as what it is, after the escalation was tried.
    const stuck = helperWorld();
    let settled: string | undefined;
    void stuck.process.close().then(() => void (settled = "resolved"), (error: Error) => void (settled = error.message));
    await tick();
    stuck.answer({ id: 0, ok: true, result: {} });
    for (let attempt = 0; attempt < 6 && settled === undefined; attempt += 1) {
      await tick();
      stuck.harness.controllers.get("csnaps-exit")?.abort(new DeadlineExceededError("csnaps-exit"));
    }
    assert.equal(settled, "csnaps process did not close after SIGKILL");
    assert.deepEqual(stuck.helper.killed, ["SIGTERM", "SIGKILL"]);
  });
});

describe("writing a frame", () => {
  it("reports a stream that refuses the bytes, whether it says so or throws", async () => {
    const refused = await settle(writeFrame({ write: (_frame: unknown, callback: (error: Error) => void) => void callback(new Error("boom")) } as never, Buffer.from("x")));
    assert.equal(String(refused), "CsnapsProcessError: csnaps stdin write failed: boom");
    const thrown = await settle(writeFrame({ write: () => { throw new Error("gone"); } } as never, Buffer.from("x")));
    assert.equal(String(thrown), "CsnapsProcessError: csnaps stdin write failed: gone");
  });

  it("says what an exit was", () => {
    assert.equal(describeCsnapsExit(3, null), "csnaps process exited with code 3");
    assert.equal(describeCsnapsExit(null, "SIGKILL"), "csnaps process exited due to signal SIGKILL");
    assert.equal(describeCsnapsExit(null, null), "csnaps process exited");
  });
});

describe("starting a real helper", () => {
  it("runs the executable, shakes hands, and stops it", async () => {
    // The helper is the platform's own executable, so the handshake is proven against a real process: a script that
    // reads the frames off its stdin and answers them the way the protocol says.
    const responder = join(scratch, "helper.mjs");
    writeFileSync(responder, `
let buffer = Buffer.alloc(0);
const frame = (text) => { const payload = Buffer.from(text, "utf8"); const head = Buffer.alloc(4); head.writeUInt32BE(payload.length, 0); return Buffer.concat([head, payload]); };
process.stdin.on("data", (chunk) => {
  buffer = Buffer.concat([buffer, chunk]);
  while (buffer.length >= 4) {
    const length = buffer.readUInt32BE(0);
    if (buffer.length < 4 + length) break;
    const request = JSON.parse(buffer.subarray(4, 4 + length).toString("utf8"));
    buffer = buffer.subarray(4 + length);
    const result = request.method === "initialize" ? { state: { tracked: [{ codebaseUuid: "123e4567-e89b-42d3-a456-426614174000", path: "/workspace", kind: 1, environment: 1 }] } } : {};
    process.stdout.write(frame(JSON.stringify({ id: request.id, ok: true, result })));
    if (request.method === "shutdown") setTimeout(() => process.exit(0), 10);
  }
});
`);
    const launcher = join(scratch, "csnaps");
    writeFileSync(launcher, `#!/bin/sh\nexec ${JSON.stringify(process.execPath)} ${JSON.stringify(responder)}\n`);
    chmodSync(launcher, 0o755);
    const harness = deadlineHarness();
    const spawned = await CsnapsProcess.spawn({
      executablePath: launcher,
      initializeParams: { authId: "account-1" },
      deadlines: { ping: harness.deadline("csnaps-ping"), initialize: harness.deadline("csnaps-initialize"), applyCodebaseSpecs: harness.deadline("csnaps-apply-codebase-specs"), snapshot: harness.deadline("csnaps-snapshot"), triggerUpload: harness.deadline("csnaps-trigger-upload"), flushPendingUploads: harness.deadline("csnaps-flush-pending-uploads"), shutdown: harness.deadline("csnaps-shutdown"), exit: harness.deadline("csnaps-exit") },
    });
    assert.deepEqual(spawned.initialState, { tracked: [{ codebaseUuid: "123e4567-e89b-42d3-a456-426614174000", path: "/workspace", kind: 1, environment: 1 }] });
    await spawned.handle.close();
    assert.equal(typeof spawned.handle.terminalFailure.then, "function");
  });
});
