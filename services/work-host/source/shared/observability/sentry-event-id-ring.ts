import { SENTRY_EVENT_ID_PATTERN } from "./sentry-contracts.ts";
import type { SlateSentryEnvelope } from "./sentry-contracts.ts";
import { isEnvelopeRecord } from "./sentry-envelope-values.ts";

/** Remember the newest valid event ids so later cleanup can remove them from an offline queue. */
export class SlateSentryEventIdRing {
  private ids: string[] = [];

  constructor(readonly capacity: number) {}

  record(envelope: SlateSentryEnvelope): void {
    for (const [header, payload] of envelope[1]) {
      if (header.type !== "event" || !isEnvelopeRecord(payload)) continue;
      const eventId = payload.event_id;
      if (typeof eventId !== "string" || !SENTRY_EVENT_ID_PATTERN.test(eventId)) continue;
      this.remember(eventId);
    }
  }

  list(): string[] {
    return this.ids;
  }

  clear(): void {
    this.ids = [];
  }

  private remember(eventId: string): void {
    this.ids = [eventId, ...this.ids.filter((known) => known !== eventId)].slice(0, this.capacity);
  }
}
