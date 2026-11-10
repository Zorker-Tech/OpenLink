import assert from "node:assert/strict";
import { describe, it } from "node:test";

import {
  BOOTSTRAP_FLAG,
  adoptForkIpc,
  adoptParentPort,
  isPortLike,
  type PortLike,
} from "../../source/coordinator/carrier.ts";

const validBootstrap = () => ({ processConfig: { appVersion: "1.2.3", isPackaged: false, dataDir: "/tmp/data" } });
const bootstrapArg = () => BOOTSTRAP_FLAG + JSON.stringify(validBootstrap());

class FakePort implements PortLike {
  readonly posted: unknown[] = [];
  readonly handlers = new Map<string, Array<(event: any) => void>>();
  closed = false;
  started = false;
  postMessage(value: unknown): void { this.posted.push(value); }
  on(event: "message" | "close", listener: (value: any) => void): void {
    const list = this.handlers.get(event) ?? [];
    list.push(listener);
    this.handlers.set(event, list);
  }
  close(): void { this.closed = true; }
  start(): void { this.started = true; }
  emit(event: "message" | "close", payload: unknown): void {
    for (const listener of this.handlers.get(event) ?? []) listener(payload);
  }
}

function handlers() {
  const received: Array<[string, unknown]> = [];
  return {
    received,
    intake: {
      onControlFrame: (value: unknown) => received.push(["control", value]),
      onDataFrame: (value: unknown) => received.push(["data", value]),
      onMainDataFrame: (value: unknown) => received.push(["mainData", value]),
      onClosed: () => received.push(["closed", undefined]),
    },
  };
}

function withProcessSend(run: (send: (value: unknown, callback: () => void) => void) => Promise<void> | void) {
  const originalSend = process.send;
  const sent: unknown[] = [];
  (process as unknown as { send: unknown }).send = (value: unknown, callback: () => void) => { sent.push(value); callback(); };
  return Promise.resolve(run((value, callback) => { sent.push(value); callback(); })).then(() => sent).finally(() => {
    (process as unknown as { send: unknown }).send = originalSend;
  });
}

describe("recognizing a message port", () => {
  it("needs postMessage and on", () => {
    assert.equal(isPortLike(new FakePort()), true);
    assert.equal(isPortLike({ postMessage: () => {}, on: () => {} }), true);
    assert.equal(isPortLike({ postMessage: () => {} }), false);
    assert.equal(isPortLike(null), false);
    assert.equal(isPortLike("port"), false);
  });
});

describe("adopting the fork ipc carrier", () => {
  it("refuses argv without a usable bootstrap", () => {
    assert.deepEqual(adoptForkIpc([]), { adopted: false, rejection: { detail: "missing --bootstrap argument" } });
    assert.deepEqual(adoptForkIpc([BOOTSTRAP_FLAG + "{not json"]), { adopted: false, rejection: { detail: "--bootstrap is not valid JSON" } });
    const badShape = adoptForkIpc([BOOTSTRAP_FLAG + "{}"]) as { adopted: false; rejection: { detail: string } };
    assert.equal(badShape.adopted, false);
    assert.equal(badShape.rejection.detail.includes("processConfig"), true);
  });

  it("reports a missing renderer channel", async () => {
    const originalSend = process.send;
    (process as unknown as { send: unknown }).send = undefined;
    try {
      assert.deepEqual(adoptForkIpc([bootstrapArg()]), { adopted: false, rejection: { detail: "no renderer data channel was transferred" } });
    } finally {
      (process as unknown as { send: unknown }).send = originalSend;
    }
  });

  it("writes each channel envelope and dispatches what arrives back", async () => {
    const originalSend = process.send;
    const originalDisconnect = process.disconnect;
    const sent: unknown[] = [];
    (process as unknown as { send: unknown }).send = (value: unknown, callback: () => void) => { sent.push(value); callback(); };
    let disconnected = false;
    (process as unknown as { disconnect: unknown }).disconnect = () => { disconnected = true; };
    try {
      const intake = adoptForkIpc([bootstrapArg()]);
      assert.equal(intake.adopted, true);
      if (!intake.adopted) return;
      assert.equal(intake.carrier.kind, "fork-ipc");
      assert.deepEqual(intake.carrier.bootstrap, validBootstrap());
      intake.carrier.control.post({ type: "control-frame" } as never);
      intake.carrier.mainData.post({ type: "main-frame" } as never);
      intake.carrier.data.post({ type: "data" });
      assert.deepEqual(sent, [
        { channel: "coordinator-control", frame: { type: "control-frame" } },
        { channel: "coordinator-main-data", frame: { type: "main-frame" } },
        { type: "data" },
      ]);
      const received = handlers();
      intake.carrier.bind(received.intake);
      intake.carrier.bind(received.intake);
      process.emit("message", { channel: "coordinator-control", frame: { type: "c" } } as never);
      process.emit("message", { channel: "coordinator-main-data", frame: { type: "m" } } as never);
      process.emit("message", { plain: true } as never);
      process.emit("disconnect" as never);
      assert.deepEqual(received.received, [
        ["control", { type: "c" }],
        ["mainData", { type: "m" }],
        ["data", { plain: true }],
        ["closed", undefined],
      ]);
      intake.carrier.control.close();
      intake.carrier.control.close();
      assert.equal(typeof disconnected, "boolean");
      intake.carrier.exitProcess(3);
      assert.equal(process.exitCode, 3);
    } finally {
      (process as unknown as { send: unknown }).send = originalSend;
      (process as unknown as { disconnect: unknown }).disconnect = originalDisconnect;
      process.exitCode = undefined;
    }
  });
});

describe("adopting the parent-port carrier", () => {
  it("refuses a handoff that did not transfer the three ports", () => {
    const result = adoptParentPort(new FakePort(), { data: { bootstrap: validBootstrap() }, ports: [] });
    assert.deepEqual(result, { adopted: false, rejection: { detail: "parent handoff did not transfer three message ports" } });
    const badBootstrap = adoptParentPort(new FakePort(), { data: { bootstrap: null }, ports: [] });
    assert.equal(badBootstrap.adopted, false);
  });

  it("posts on each port and dispatches its messages", async () => {
    const ports = [new FakePort(), new FakePort(), new FakePort()];
    const intake = adoptParentPort(new FakePort(), { data: { bootstrap: validBootstrap() }, ports });
    assert.equal(intake.adopted, true);
    if (!intake.adopted) return;
    assert.equal(intake.carrier.kind, "parent-port");
    const received = handlers();
    intake.carrier.bind(received.intake);
    intake.carrier.bind(received.intake);
    assert.deepEqual(ports.map((port) => port.started), [true, true, true]);
    ports[0]!.emit("message", { data: { type: "c" } });
    ports[1]!.emit("message", { data: { type: "d" } });
    ports[2]!.emit("message", { data: { type: "m" } });
    assert.deepEqual(received.received, [
      ["control", { type: "c" }],
      ["data", { type: "d" }],
      ["mainData", { type: "m" }],
    ]);
    intake.carrier.control.post({ type: "out-control" } as never);
    intake.carrier.data.post({ type: "out-data" });
    intake.carrier.mainData.post({ type: "out-main" });
    assert.deepEqual(ports.map((port) => port.posted), [[{ type: "out-control" }], [{ type: "out-data" }], [{ type: "out-main" }]]);
    intake.carrier.control.close();
    intake.carrier.control.close();
    assert.equal(ports[0]!.closed, true);
    ports[0]!.emit("close", undefined);
    assert.equal(received.received.some((entry) => entry[0] === "closed"), true);
    ports[1]!.emit("close", undefined);
    intake.carrier.data.post({ type: "after-close" });
    assert.equal(ports[1]!.posted.length, 1);
  });
});
