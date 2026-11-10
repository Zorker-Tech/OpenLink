/**
 * What the egress exit client blocks, connects, relays, reconnects and closes on the tunnel wire.
 */

import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { describe, it } from "node:test";

import type { RetryPolicy } from "../../source/host/extensions/scheduling.ts";
import {
  EgressTunnelExitClient,
  KIND_CLOSE,
  KIND_DATA,
  KIND_OPEN,
  RECONNECT_INITIAL_DELAY_MS,
  RECONNECT_MAX_DELAY_MS,
  SOCKET_HIGH_WATER_MARK,
  decodeFrame,
  encodeClose,
  encodeData,
  embeddedV4,
  expandV6,
  isBlockedIp,
  isBlockedV4,
  isBlockedV6,
  isReservedV4,
  isSharedCgnat,
  resolveChecked,
  toBuffer,
  type EgressFrame,
} from "../../source/shared/node/egress-tunnel/exit-client.ts";
import type { TunnelConfig } from "../../source/shared/node/egress-tunnel/box-connection.ts";
import type { ExitWebSocket } from "../../source/shared/node/egress-tunnel/exit-client.ts";

class FakeWebSocket extends EventEmitter {
  readyState = 0;
  binaryType = "";
  bufferedAmount = 0;
  readonly sent: Buffer[] = [];
  closed = false;
  terminated = false;

  send(data: Buffer, callback?: () => void): void {
    this.sent.push(Buffer.from(data));
    callback?.();
  }

  close(): void {
    this.closed = true;
    this.readyState = 3;
    this.emit("close");
  }

  terminate(): void {
    this.terminated = true;
    this.readyState = 3;
    this.emit("close");
  }
}

class FakeSocket extends EventEmitter {
  readonly writes: Buffer[] = [];
  options: { host: string; port: number } | undefined;
  paused = false;
  ended = false;
  destroyed = false;

  write(data: Buffer): boolean {
    this.writes.push(Buffer.from(data));
    return true;
  }

  end(): void {
    this.ended = true;
  }

  destroy(): void {
    if (this.destroyed) return;
    this.destroyed = true;
    this.emit("close");
  }

  pause(): void {
    this.paused = true;
  }

  resume(): void {
    this.paused = false;
  }

  isPaused(): boolean {
    return this.paused;
  }
}

function world(options: {
  readonly allowPrivate?: boolean;
  readonly lookup?: (host: string) => Promise<Array<{ address: string; family: number }>>;
  readonly retry?: RetryPolicy;
} = {}) {
  const websocket = new FakeWebSocket();
  const websockets = [websocket];
  let websocketCreations = 0;
  const sockets: FakeSocket[] = [];
  const statusUpdates: Array<{ state: string; relayedStreams: number; activeStreams: number; lastError?: string }> = [];
  const logs: string[] = [];
  const config: TunnelConfig = {
    url: "wss://box.example.test:8790/",
    bearer: "tunnel-token",
    headers: { "x-box": "one" },
    allowPrivateTargets: options.allowPrivate === true,
  };
  const client = new EgressTunnelExitClient({
    config,
    onStatus: (status) => statusUpdates.push(status),
    log: (message) => logs.push(message),
    createWebSocket: (url, wsOptions) => {
      logs.push(url + " " + wsOptions.headers.authorization + " " + wsOptions.headers["x-box"]);
      websocketCreations += 1;
      if (websocketCreations > 1) websockets.push(new FakeWebSocket());
      return websockets[websocketCreations - 1] as unknown as ExitWebSocket;
    },
    lookup: (options.lookup ?? (async () => [{ address: "8.8.8.8", family: 4 }])) as never,
    createConnection: ((connectionOptions: { host: string; port: number }) => {
      const socket = new FakeSocket();
      socket.options = connectionOptions;
      sockets.push(socket);
      return socket;
    }) as never,
    openReadyState: 1,
    ...(options.retry === undefined ? {} : { reconnectPolicy: options.retry }),
  });
  return { client, websocket, websockets, sockets, statusUpdates, logs, websocketCreations: () => websocketCreations };
}

function openFrame(streamId: number, host: string, port: number): Buffer {
  const hostBytes = Buffer.from(host, "utf8");
  const frame = Buffer.alloc(7 + hostBytes.length);
  frame[0] = KIND_OPEN;
  frame.writeUInt32BE(streamId, 1);
  frame.writeUInt16BE(port, 5);
  hostBytes.copy(frame, 7);
  return frame;
}

function tick(): Promise<void> {
  return new Promise((resolve) => setImmediate(resolve));
}

describe("the egress frame wire", () => {
  it("decodes opens, data and closes without inventing truncated frames", () => {
    assert.deepEqual([RECONNECT_INITIAL_DELAY_MS, RECONNECT_MAX_DELAY_MS], [2_000, 30_000]);
    const open = decodeFrame(openFrame(7, "example.test", 443));
    assert.deepEqual(open, { kind: KIND_OPEN, streamId: 7, host: "example.test", port: 443 });
    assert.deepEqual(decodeFrame(encodeData(8, Buffer.from("data"))), { kind: KIND_DATA, streamId: 8, payload: Buffer.from("data") });
    assert.deepEqual(decodeFrame(encodeClose(9)), { kind: KIND_CLOSE, streamId: 9 });
    assert.deepEqual([decodeFrame(Buffer.alloc(4)), decodeFrame(Buffer.from([KIND_OPEN, 0, 0, 0, 1])), decodeFrame(Buffer.from([99, 0, 0, 0, 1]))], [null, null, null]);
  });

  it("converts the three supported websocket binary payload shapes", () => {
    const bytes = Buffer.from([1, 2, 3]);
    assert.equal(toBuffer(bytes), bytes);
    assert.deepEqual(toBuffer([Buffer.from([1]), Buffer.from([2, 3])]), bytes);
    assert.deepEqual(toBuffer(Uint8Array.from([1, 2, 3]).buffer), bytes);
  });
});

describe("blocking private and special-purpose targets", () => {
  it("recognizes special IPv4 blocks, reserved ranges and shared carrier space", () => {
    assert.equal(isSharedCgnat([100, 64, 0, 1]), true);
    assert.equal(isSharedCgnat([100, 128, 0, 1]), false);
    assert.equal(isReservedV4([198, 18, 0, 1]), true);
    assert.equal(isReservedV4([240, 0, 0, 1]), true);
    for (const ip of [
      [10, 0, 0, 1], [172, 16, 0, 1], [192, 168, 1, 1], [127, 0, 0, 1], [169, 254, 1, 1],
      [255, 255, 255, 255], [192, 0, 2, 1], [198, 51, 100, 2], [203, 0, 113, 3], [0, 0, 0, 0],
      [224, 0, 0, 1], [100, 64, 0, 1], [240, 0, 0, 1],
    ]) assert.equal(isBlockedV4(ip), true, ip.join("."));
    assert.equal(isBlockedV4([8, 8, 8, 8]), false);
    assert.equal(isBlockedIp("not-an-ip"), true);
  });

  it("expands IPv6 forms, maps embedded IPv4 and blocks local, multicast and special prefixes", () => {
    assert.deepEqual(expandV6("::1"), [0, 0, 0, 0, 0, 0, 0, 1]);
    assert.deepEqual(expandV6("2001:db8::1%eth0")?.slice(0, 4), [8193, 3512, 0, 0]);
    assert.equal(expandV6("1::2::3"), null);
    assert.deepEqual(embeddedV4([0, 0, 0, 0, 0, 65535, 0x0808, 0x0808]), [8, 8, 8, 8]);
    assert.deepEqual(embeddedV4([0, 0, 0, 0, 0, 65535, 0x0a00, 1]), [10, 0, 0, 1]);
    for (const ip of ["::", "::1", "fc00::1", "fe80::1", "ff02::1", "::ffff:10.0.0.1", "64:ff9b::10.0.0.1"]) {
      assert.equal(isBlockedV6(ip), true, ip);
    }
    assert.equal(isBlockedV6("2001:4860:4860::8888"), false);
  });

  it("uses all DNS answers, refuses all-blocked hosts and permits private targets only when configured", async () => {
    const addresses = [
      { address: "10.1.2.3", family: 4 },
      { address: "203.0.113.9", family: 4 },
      { address: "8.8.8.8", family: 4 },
    ];
    assert.equal(await resolveChecked("host.example", false, (async () => addresses) as never), "8.8.8.8");
    assert.equal(await resolveChecked("host.example", true, (async () => addresses) as never), "10.1.2.3");
    assert.equal(await resolveChecked("host.example", false, (async () => [addresses[0]!]) as never), null);
    assert.equal(await resolveChecked("host.example", false, async () => { throw new Error("dns failed"); }), null);
    assert.equal(await resolveChecked("192.168.1.1", false), null);
    assert.equal(await resolveChecked("192.168.1.1", true), "192.168.1.1");
  });
});

describe("the exit connection and stream table", () => {
  it("opens with the configured token and headers, then relays buffered and live data", async () => {
    let releaseLookup: ((value: Array<{ address: string; family: number }>) => void) | undefined;
    const pendingLookup = new Promise<Array<{ address: string; family: number }>>((resolve) => { releaseLookup = resolve; });
    const current = world({ lookup: async () => await pendingLookup });
    current.client.start();
    current.client.start();
    assert.deepEqual(current.logs.slice(0, 1), ["wss://box.example.test:8790/ Bearer tunnel-token one"]);
    assert.equal(current.websocket.binaryType, "nodebuffer");
    current.websocket.readyState = 1;
    current.websocket.emit("open");
    current.client.handleFrame(openFrame(1, "exit.example", 443));
    current.client.handleFrame(encodeData(1, Buffer.from("before-connect")));
    releaseLookup?.([{ address: "8.8.8.8", family: 4 }]);
    await tick();

    const socket = current.sockets[0]!;
    assert.deepEqual(socket.options, { host: "8.8.8.8", port: 443 });
    assert.deepEqual(socket.writes, [Buffer.from("before-connect")]);
    assert.deepEqual(current.statusUpdates.at(-1), { state: "connected", relayedStreams: 1, activeStreams: 1, lastError: undefined });

    socket.emit("data", Buffer.from("reply"));
    assert.deepEqual(decodeFrame(current.websocket.sent.at(-1)!), { kind: KIND_DATA, streamId: 1, payload: Buffer.from("reply") });
    current.websocket.bufferedAmount = SOCKET_HIGH_WATER_MARK + 1;
    socket.emit("data", Buffer.from("busy"));
    assert.equal(socket.isPaused(), true);
    current.websocket.bufferedAmount = 0;
    socket.emit("data", Buffer.from("drained"));
    assert.equal(socket.isPaused(), false);
    current.client.handleFrame(encodeClose(1));
    assert.equal(socket.ended, true);
    assert.equal(current.client.getStatus().activeStreams, 0);
    current.client.stop();
  });

  it("refuses blocked resolutions, closes duplicate stream ids and cleans up socket failures", async () => {
    const current = world({ lookup: async () => [{ address: "127.0.0.1", family: 4 }] });
    current.client.start();
    current.websocket.readyState = 1;
    current.websocket.emit("open");
    current.client.handleFrame(openFrame(2, "blocked.example", 80));
    await tick();
    assert.deepEqual(current.sockets, []);
    assert.deepEqual(decodeFrame(current.websocket.sent.at(-1)!), { kind: KIND_CLOSE, streamId: 2 });
    assert.match(current.logs.at(-1) ?? "", /refused stream 2/);

    current.client.handleFrame(openFrame(3, "blocked.example", 80));
    current.client.handleFrame(openFrame(3, "blocked.example", 80));
    await tick();
    assert.deepEqual(
      current.websocket.sent.map((frame) => decodeFrame(frame)).filter((frame) => frame?.streamId === 3).map((frame) => frame?.kind),
      [KIND_CLOSE, KIND_CLOSE],
    );

    const publicWorld = world();
    publicWorld.client.start();
    publicWorld.websocket.readyState = 1;
    publicWorld.websocket.emit("open");
    publicWorld.client.handleFrame(openFrame(4, "public.example", 80));
    await tick();
    const socket = publicWorld.sockets[0]!;
    socket.emit("error", new Error("connection failed"));
    assert.equal(publicWorld.client.getStatus().activeStreams, 0);
    assert.deepEqual(decodeFrame(publicWorld.websocket.sent.at(-1)!), { kind: KIND_CLOSE, streamId: 4 });
    publicWorld.client.stop();
    current.client.stop();
  });

  it("schedules one reconnect at a time and does not reconnect after stop", async () => {
    const elapsed: Array<() => void> = [];
    const attempts: number[] = [];
    const retry = {
      name: "test-reconnect",
      schedule: (attempt: number) => {
        attempts.push(attempt);
        let resolve!: () => void;
        const promise = new Promise<void>((done) => { resolve = done; });
        elapsed.push(resolve);
        return { elapsed: promise, dispose: () => {} };
      },
      runWithRetry: async () => undefined,
    } as RetryPolicy;
    const current = world({ retry });
    current.client.start();
    current.client.start();
    assert.equal(current.websocketCreations(), 1);
    current.websocket.emit("close");
    assert.deepEqual(attempts, [1]);
    assert.equal(current.client.getStatus().state, "connecting");
    elapsed[0]?.();
    await tick();
    assert.equal(current.websocketCreations(), 2);
    current.websockets[1]?.emit("close");
    assert.deepEqual(attempts, [1, 2]);
    current.client.stop();
    elapsed[1]?.();
    await tick();
    assert.equal(current.websocketCreations(), 2);
    assert.equal(current.client.getStatus().state, "off");
  });
});
