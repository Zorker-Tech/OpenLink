import { lookup as dnsLookup } from "node:dns/promises";
import { createConnection, type Socket } from "node:net";
import { createRetryPolicy, realClock, type RetryPolicy } from "../../../host/extensions/scheduling.ts";
import type { EgressTunnelStatus } from "./egress-tunnel-controller-contracts.ts";
import { decodeFrame, encodeClose, encodeData, toBuffer } from "./egress-frame-codec.ts";
import {
  KIND_CLOSE,
  KIND_DATA,
  KIND_OPEN,
  RECONNECT_INITIAL_DELAY_MS,
  RECONNECT_MAX_DELAY_MS,
  SOCKET_HIGH_WATER_MARK,
  type EgressTunnelExitClientOptions,
  type ExitWebSocket,
} from "./exit-client-contracts.ts";
import { resolveChecked } from "./egress-target-policy.ts";

interface ActiveStream {
  socket: Socket | null;
  pending: Buffer[];
  closedByPeer: boolean;
}

export class EgressTunnelExitClient {
  private websocket: ExitWebSocket | null = null;
  private readonly streams = new Map<number, ActiveStream>();
  private reconnectAttempt = 0;
  private reconnectAbort: AbortController | null = null;
  private stopped = true;
  private state = "off";
  private relayedStreams = 0;
  private lastError: string | undefined;
  private readonly reconnectPolicy: RetryPolicy;

  constructor(private readonly options: EgressTunnelExitClientOptions) {
    this.reconnectPolicy = options.reconnectPolicy ?? createRetryPolicy(realClock, {
      name: "slate-egress-tunnel-reconnect",
      maxAttempts: 1_000_000,
      initialDelayMs: RECONNECT_INITIAL_DELAY_MS,
      maxDelayMs: RECONNECT_MAX_DELAY_MS,
    });
  }

  start(): void {
    if (!this.stopped) return;
    this.stopped = false;
    this.connect();
  }

  stop(): void {
    this.stopped = true;
    this.reconnectAbort?.abort();
    this.reconnectAbort = null;
    const websocket = this.websocket;
    this.websocket = null;
    if (websocket != null) {
      websocket.removeAllListeners();
      try {
        websocket.close();
      } catch {
        websocket.terminate();
      }
    }
    for (const stream of this.streams.values()) stream.socket?.destroy();
    this.streams.clear();
    this.setState("off");
  }

  getStatus(): EgressTunnelStatus {
    return {
      state: this.state,
      relayedStreams: this.relayedStreams,
      activeStreams: this.streams.size,
      lastError: this.lastError,
    };
  }

  handleFrame(bytes: Buffer): void {
    const frame = decodeFrame(bytes);
    if (frame == null) return;

    if (frame.kind === KIND_OPEN) {
      void this.openStream(frame.streamId, frame.host, frame.port);
      return;
    }
    if (frame.kind === KIND_DATA) {
      const stream = this.streams.get(frame.streamId);
      if (stream?.socket != null) stream.socket.write(frame.payload);
      else stream?.pending.push(frame.payload);
      return;
    }

    const stream = this.streams.get(frame.streamId);
    if (stream == null) return;
    if (stream.socket != null) {
      this.streams.delete(frame.streamId);
      stream.socket.end();
    } else {
      stream.closedByPeer = true;
    }
  }

  private setState(state: string): void {
    this.state = state;
    this.publishStatus();
  }

  private publishStatus(): void {
    this.options.onStatus(this.getStatus());
  }

  private connect(): void {
    if (this.stopped) return;
    this.setState("connecting");
    const websocket = this.options.createWebSocket(this.options.config.url, {
      headers: {
        ...this.options.config.headers,
        authorization: "Bearer " + this.options.config.bearer,
      },
    });
    this.websocket = websocket;
    websocket.binaryType = "nodebuffer";
    websocket.on("open", () => {
      this.lastError = undefined;
      this.reconnectAttempt = 0;
      this.options.log?.("egress-tunnel: attached to " + this.options.config.url);
      this.setState("connected");
    });
    websocket.on("message", (data, isBinary) => {
      if (isBinary) this.handleFrame(toBuffer(data));
    });
    websocket.on("error", (error) => {
      this.lastError = error.message;
      this.options.log?.("egress-tunnel: socket error: " + error.message);
    });
    websocket.on("close", () => {
      if (this.websocket === websocket) this.websocket = null;
      for (const stream of this.streams.values()) stream.socket?.destroy();
      this.streams.clear();
      this.scheduleReconnect();
    });
  }

  private scheduleReconnect(): void {
    if (this.stopped) {
      this.setState("off");
      return;
    }
    this.setState("connecting");
    this.options.log?.("egress-tunnel: detached; scheduling reconnect");
    const abortController = new AbortController();
    this.reconnectAbort = abortController;
    const delay = this.reconnectPolicy.schedule(++this.reconnectAttempt, abortController.signal);
    void delay.elapsed.then(() => {
      if (this.stopped || this.reconnectAbort !== abortController) return;
      this.reconnectAbort = null;
      this.connect();
    }, () => {});
  }

  private send(frame: Buffer): void {
    if (this.websocket?.readyState === (this.options.openReadyState ?? 1)) this.websocket.send(frame);
  }

  private async openStream(streamId: number, hostname: string, port: number): Promise<void> {
    if (this.streams.has(streamId)) {
      this.send(encodeClose(streamId));
      return;
    }

    const stream: ActiveStream = { socket: null, pending: [], closedByPeer: false };
    this.streams.set(streamId, stream);
    const resolvedAddress = await resolveChecked(
      hostname,
      this.options.config.allowPrivateTargets === true,
      this.options.lookup ?? dnsLookup,
    );
    const websocketReady = this.websocket?.readyState === (this.options.openReadyState ?? 1);
    if (resolvedAddress == null || this.stopped || this.streams.get(streamId) !== stream || !websocketReady) {
      if (resolvedAddress == null) this.options.log?.("egress-tunnel: refused stream " + streamId + " (unresolvable or blocked)");
      this.streams.delete(streamId);
      this.send(encodeClose(streamId));
      return;
    }

    const socket = (this.options.createConnection ?? createConnection)({ host: resolvedAddress, port });
    stream.socket = socket;
    this.relayedStreams += 1;
    this.options.log?.("egress-tunnel: relaying stream " + streamId);
    this.publishStatus();

    socket.on("data", (chunk: Buffer) => {
      const websocket = this.websocket;
      if (websocket?.readyState !== (this.options.openReadyState ?? 1)) return;
      websocket.send(encodeData(streamId, chunk), () => {
        if (socket.isPaused() && (this.websocket?.bufferedAmount ?? 0) <= SOCKET_HIGH_WATER_MARK) socket.resume();
      });
      if (websocket.bufferedAmount > SOCKET_HIGH_WATER_MARK) socket.pause();
    });
    socket.on("error", () => this.teardownStream(streamId, socket));
    socket.on("close", () => this.teardownStream(streamId, socket));
    for (const payload of stream.pending) socket.write(payload);
    stream.pending = [];
    if (stream.closedByPeer) socket.end();
  }

  private teardownStream(streamId: number, socket: Socket): void {
    const stream = this.streams.get(streamId);
    if (stream?.socket !== socket) return;
    this.streams.delete(streamId);
    socket.destroy();
    this.send(encodeClose(streamId));
    this.publishStatus();
  }
}
