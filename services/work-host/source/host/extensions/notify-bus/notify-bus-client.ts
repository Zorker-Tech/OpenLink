/** Client for Slate's host notification stream, with reconnect and idle-watchdog lifecycle. */
import { getSlateBackendClientHeaders } from "../../../adapters/interop/backend/slate-client-metadata-adapter.ts";
import {
  HEALTHY_CONNECTION_MIN_LIFETIME_MS,
  SlateNotifyStreamError,
  type SlateNotifyBusClientDependencies,
  type SlateNotifyFrame,
} from "./notify-bus-contracts.ts";
import { parseNotifyFrame } from "./notify-bus-frame.ts";
import { consumeNotifyEventStream } from "./notify-bus-sse.ts";

export {
  SLATE_NOTIFY_TOPIC_FLAGS,
  SLATE_NOTIFY_TOPICS,
  HEALTHY_CONNECTION_MIN_LIFETIME_MS,
  SlateNotifyStreamError,
} from "./notify-bus-contracts.ts";
export type { SlateNotifyTopic, SlateNotifyFrame } from "./notify-bus-contracts.ts";
export { isSlateNotifyTopic, parseNotifyFrame } from "./notify-bus-frame.ts";

export class SlateNotifyBusClient {
  private readonly fetchImpl: typeof fetch;
  readonly #ports: SlateNotifyBusClientDependencies;
  private stopController: AbortController | null = null;
  private streamController: AbortController | null = null;
  #connectedSince: number | null = null;

  constructor(ports: SlateNotifyBusClientDependencies) {
    this.#ports = ports;
    this.fetchImpl = ports.fetchImpl ?? fetch;
  }

  isConnected(): boolean {
    return this.#connectedSince != null;
  }

  start(): void {
    if (this.stopController != null) return;
    this.stopController = new AbortController();
    void this.runUntilStopped(this.stopController.signal);
  }

  stop(): void {
    this.stopController?.abort();
    this.stopController = null;
    this.streamController?.abort();
    this.streamController = null;
    this.#connectedSince = null;
  }

  async streamOnce(stopSignal: AbortSignal): Promise<void> {
    const backendUrl = this.#ports.getBackendUrl();
    const accessToken = await this.#ports.getAccessToken({ backendUrl });
    if (stopSignal.aborted) return;

    const controller = new AbortController();
    this.streamController = controller;
    const watchdog = this.#ports.stallWatchdog.arm(() => controller.abort());
    try {
      const response = await this.fetchImpl(new URL("/slate/notify", backendUrl).toString(), {
        headers: {
          authorization: `Bearer ${accessToken}`,
          accept: "text/event-stream",
          ...getSlateBackendClientHeaders(),
        },
        signal: controller.signal,
      });
      if (!response.ok || response.body == null) throw new SlateNotifyStreamError(response.status);

      await consumeNotifyEventStream(response.body, watchdog, (frame) => this.handleFrame(stopSignal, frame));
    } finally {
      watchdog.dispose();
      if (this.streamController === controller) this.streamController = null;
    }
  }

  private async runUntilStopped(stopSignal: AbortSignal): Promise<void> {
    let attempt = 0;
    while (!stopSignal.aborted) {
      try {
        await this.streamOnce(stopSignal);
      } catch (error) {
        if (!stopSignal.aborted) this.#ports.onStreamError(error);
      }
      if (stopSignal.aborted) return;

      const now = this.#ports.now ?? Date.now;
      const connectionWasHealthy = this.#connectedSince != null
        && now() - this.#connectedSince >= HEALTHY_CONNECTION_MIN_LIFETIME_MS;
      this.#connectedSince = null;
      attempt = connectionWasHealthy ? 0 : attempt + 1;
      if (attempt > 0 && !await this.waitBeforeReconnect(attempt, stopSignal)) return;
    }
  }

  private async waitBeforeReconnect(attempt: number, stopSignal: AbortSignal): Promise<boolean> {
    const delay = this.#ports.reconnectBackoff.schedule(attempt, stopSignal);
    try {
      await delay.elapsed;
      return true;
    } catch (error) {
      if (!stopSignal.aborted) this.#ports.onStreamError(error);
      return false;
    } finally {
      delay.dispose();
    }
  }

  private handleFrame(stopSignal: AbortSignal, frame: string): void {
    if (stopSignal.aborted) return;
    const message: SlateNotifyFrame = parseNotifyFrame(frame);
    if (message.kind === "connected") {
      this.#connectedSince = (this.#ports.now ?? Date.now)();
      this.#ports.onConnected();
    } else if (message.kind === "notify") {
      this.#ports.onNotify(message.topic);
    }
  }
}
