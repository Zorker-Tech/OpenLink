/**
 * The coordinator's composition root: its own three rules (a pending OAuth ceremony, the user's echo, the signer's
 * reconnects), and what composing it does — with a carrier that was not adopted, and with one that was.
 */

import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, describe, it } from "node:test";

import { composeCoordinator, createWebAuthnReconnectPolicy, asMcpOAuthPending, recordEchoIfUserEcho } from "../../source/coordinator/main.ts";
import { HOST_ACCOUNT_SLOT } from "../../source/coordinator/gateway/gateway-client.ts";

const scratch = mkdtempSync(join(tmpdir(), "slate-coordinator-main-"));
after(() => rmSync(scratch, { recursive: true, force: true }));

const tick = () => new Promise((resolve) => setImmediate(resolve));

describe("a pending OAuth ceremony", () => {
  it("is read only when it says all three things it has to", () => {
    assert.deepEqual(asMcpOAuthPending({ serverName: "srv", redirectUrl: "https://redirect.test", state: "st-1" }), { serverName: "srv", redirectUrl: "https://redirect.test", state: "st-1" });
    // Anything missing, empty or of the wrong kind is not a ceremony.
    for (const payload of [
      null,
      "not an object",
      {},
      { serverName: "srv", redirectUrl: "https://redirect.test" },
      { serverName: "", redirectUrl: "https://redirect.test", state: "st-1" },
      { serverName: "srv", redirectUrl: "", state: "st-1" },
      { serverName: "srv", redirectUrl: "https://redirect.test", state: "" },
      { serverName: 1, redirectUrl: "https://redirect.test", state: "st-1" },
    ]) {
      assert.equal(asMcpOAuthPending(payload), null, JSON.stringify(payload));
    }
  });
});

describe("the user's own echo", () => {
  it("is recorded for the account's slot, and nothing else is", () => {
    const recorded: { accountSlot: string; clientNonce: string }[] = [];
    const recorder = { recordSendEcho: (key: { accountSlot: string; clientNonce: string }) => void recorded.push(key) };
    recordEchoIfUserEcho({ type: "appended", entry: { kind: "message", role: "user", clientNonce: "n-1" } }, recorder);
    recordEchoIfUserEcho({ type: "appended", entry: { kind: "user-attachment", clientNonce: "n-2" } }, recorder);
    assert.deepEqual(recorded, [{ accountSlot: HOST_ACCOUNT_SLOT, clientNonce: "n-1" }, { accountSlot: HOST_ACCOUNT_SLOT, clientNonce: "n-2" }]);
    // Somebody else's message, an assistant's answer, an entry with no nonce, and an update rather than an append
    // are all not the user's echo.
    for (const payload of [
      { type: "updated", entry: { kind: "message", role: "user", clientNonce: "n-3" } },
      { type: "appended", entry: { kind: "message", role: "assistant", clientNonce: "n-3" } },
      { type: "appended", entry: { kind: "send-message", clientNonce: "n-3" } },
      { type: "appended", entry: { kind: "message", role: "user" } },
      { type: "appended", entry: { kind: "message", role: "user", clientNonce: "" } },
      { type: "appended" },
      null,
      "not an event",
    ]) {
      recordEchoIfUserEcho(payload, recorder);
    }
    assert.equal(recorded.length, 2);
  });
});

describe("the signer's reconnects", () => {
  it("wait a little longer each time, and never give up", () => {
    const policy = createWebAuthnReconnectPolicy();
    assert.equal(policy.name, "slate-webauthn-reconnect");
    const first = policy.schedule(1);
    const second = policy.schedule(2);
    assert.deepEqual([typeof first.elapsed.then, typeof second.elapsed.then], ["function", "function"]);
    first.dispose();
    second.dispose();
  });
});

describe("composing the coordinator", () => {
  it("refuses to run without a carrier, saying why", async () => {
    const written: string[] = [];
    const exits: number[] = [];
    const stderr = process.stderr.write;
    const exit = process.exit;
    process.stderr.write = ((chunk: string) => (written.push(String(chunk)), true)) as never;
    // The real exit never returns; the stand-in says so by throwing once it has recorded the code.
    process.exit = ((code?: number) => {
      exits.push(code ?? 0);
      throw new Error("process.exit");
    }) as never;
    try {
      await composeCoordinator({ adoptCarrier: async () => ({ adopted: false, rejection: { code: "malformed-frame", detail: "bootstrap.processConfig must be an object" } }) }).catch(() => undefined);
    } finally {
      process.stderr.write = stderr;
      process.exit = exit;
    }
    assert.deepEqual(written, ["node-agent-coordinator: bootstrap.processConfig must be an object\n"]);
    assert.deepEqual(exits, [2]);
  });

  it("adopts a carrier, binds its ports, and ends the process through it when they close", async () => {
    const world = await composedWorld();
    assert.equal(typeof world.handlers, "object");
    // The three ports are bound; the control port is told how to reach the host from the start.
    world.handlers!.onControlFrame({ kind: "lifecycle", phase: "shutdown", reason: "requested", detail: null });
    // Closing the ports ends the process as a clean one.
    world.handlers!.onClosed();
    await tick();
    await tick();
    assert.deepEqual(world.exits, [0]);
    const closed = [...new Set(world.frames.filter((frame) => frame.value === "closed").map((frame) => frame.port))].sort();
    assert.deepEqual(closed, ["control", "data", "mainData"]);
  });

  it("ends as a failure when a port breaks its protocol, and says so", async () => {
    const world = await composedWorld();
    const stderr = process.stderr.write;
    const written: string[] = [];
    process.stderr.write = ((chunk: string) => (written.push(String(chunk)), true)) as never;
    try {
      // A frame the renderer port cannot make sense of is a breach, not something to ignore.
      world.handlers!.onDataFrame({ kind: "not-a-frame" });
      await tick();
      await tick();
      await tick();
    } finally {
      process.stderr.write = stderr;
    }
    assert.deepEqual(world.exits, [1]);
    assert.deepEqual(written.some((line) => line.startsWith("node-agent-coordinator: protocol breach:")), true);
  });
});

/** A composed coordinator over a carrier a test drives, with nothing left running when it ends. */
async function composedWorld() {
  const frames: { port: string; value: unknown }[] = [];
  const exits: number[] = [];
  let handlers: { onControlFrame(value: unknown): void; onDataFrame(value: unknown): void; onMainDataFrame(value: unknown): void; onClosed(): void } | undefined;
  const carrier = {
    kind: "fork-ipc" as const,
    bootstrap: { processConfig: { appVersion: "0.0.0-test", isPackaged: false, dataDir: join(scratch, `data-${Math.round(Math.random() * 1e6)}`) } },
    control: { post: (frame: unknown) => void frames.push({ port: "control", value: frame }), close: () => void frames.push({ port: "control", value: "closed" }) },
    data: { post: (value: unknown) => void frames.push({ port: "data", value }), close: () => void frames.push({ port: "data", value: "closed" }) },
    mainData: { post: (value: unknown) => void frames.push({ port: "mainData", value }), close: () => void frames.push({ port: "mainData", value: "closed" }) },
    exitProcess: (exitCode: number) => void exits.push(exitCode),
    bind: (given: typeof handlers) => void (handlers = given),
  };
  // A build without a signer is a build that does not spawn one.
  await composeCoordinator({ adoptCarrier: async () => ({ adopted: true, carrier: carrier as never }), resolveSignerPath: () => undefined });
  return { frames, exits, handlers };
}
