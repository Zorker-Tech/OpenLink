import { createNotifyDrainGate } from "../notifications/notify-drain-gate.ts";
import { XUSER_RELAY_ERROR_BACKOFF_MS, type XuserRelayClientDependencies } from "./xuser-relay-contracts.ts";

type RelayCall = <Result>(path: string, body: unknown) => Promise<Result>;
type PollingDependencies = Pick<
  XuserRelayClientDependencies,
  "clock" | "isNotifyConnected" | "isNotifySafetyPollEnabled" | "onEvent" | "onPollError" | "pollPolicy"
>;

/** Coordinates poll timing, in-flight exclusion, event delivery and relay acknowledgements. */
export class XuserRelayPolling {
  #polling: { dispose(): void } | null = null;
  #tickInProgress = false;
  #retryAfterMs = 0;
  #acknowledgements: string[] = [];
  readonly #drainGate;

  constructor(private readonly deps: PollingDependencies, private readonly call: RelayCall) {
    this.#drainGate = createNotifyDrainGate({
      isConnected: () => deps.isNotifyConnected?.() ?? false,
      isSafetyPollEnabled: () => deps.isNotifySafetyPollEnabled?.() ?? true,
      now: () => deps.clock.now(),
    });
  }

  start(): void {
    if (this.#polling !== null) return;
    this.#drainGate.reset();
    this.#polling = this.deps.pollPolicy.start(() => this.tick());
  }

  stop(): void {
    this.#polling?.dispose();
    this.#polling = null;
    this.#retryAfterMs = 0;
  }

  requestDrain(): void {
    this.#drainGate.recordNotify();
    if (this.#polling !== null) void this.tick();
  }

  async tick(): Promise<void> {
    if (this.#tickInProgress || this.deps.clock.now() < this.#retryAfterMs) return;
    if (!this.#drainGate.shouldDrain({ hasOwedWork: this.#acknowledgements.length > 0 })) return;

    this.#tickInProgress = true;
    try {
      const result = await this.call<{ events?: unknown }>("/slate/xuser/poll", { ackIds: this.#acknowledgements });
      this.#acknowledgements = await this.processEvents(result.events);
      this.#drainGate.recordPoll();
    } catch (error) {
      this.#retryAfterMs = this.deps.clock.now() + XUSER_RELAY_ERROR_BACKOFF_MS;
      this.deps.onPollError?.(error);
    } finally {
      this.#tickInProgress = false;
    }
  }

  private async processEvents(rawEvents: unknown): Promise<string[]> {
    const previouslyAcknowledged = new Set(this.#acknowledgements);
    const nextAcknowledgements: string[] = [];
    const acknowledgedThisPoll = new Set<string>();
    const acknowledge = (id: string) => {
      nextAcknowledgements.push(id);
      acknowledgedThisPoll.add(id);
    };

    for (const value of Array.isArray(rawEvents) ? rawEvents : []) {
      if (typeof value !== "object" || value === null) continue;
      const event = value as Record<string, unknown>;
      if (typeof event.id !== "string" || typeof event.kind !== "string") continue;
      if (previouslyAcknowledged.has(event.id) || acknowledgedThisPoll.has(event.id)) {
        acknowledge(event.id);
        continue;
      }
      try {
        if (await this.deps.onEvent(event)) acknowledge(event.id);
      } catch {
        // A handler failure leaves the event unacknowledged so a later poll can retry it.
      }
    }
    return nextAcknowledgements;
  }
}
