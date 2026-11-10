/**
 * Events that are held until they can be sent.
 *
 * A client that is not allowed to send analytics yet keeps the events it is told about, in the order they happened, so
 * a later flush can hand them over. This buffer is the held side of that: it records events and hands them back, and
 * flushing it is a no-op until the deferred client is activated. An event carries its name, the properties it was
 * tracked with, and the time it happened.
 */
export interface DeferredAnalyticsEvent { eventName: string; props?: Readonly<Record<string, unknown>> | undefined; timestamp?: number | undefined }
export class DeferredAnalyticsBuffer {
  private events: DeferredAnalyticsEvent[] = [];

  /** Keeps one event until the buffer is flushed or cleared. */
  track(name: string, properties?: Readonly<Record<string, unknown>>, happenedAt?: number): void {
    const event: DeferredAnalyticsEvent = { eventName: name, props: properties, timestamp: happenedAt };
    this.events.push(event);
  }

  /** Nothing leaves this buffer by flushing it: it is the held side of an analytics client. */
  async flush(_waitMs: number): Promise<void> {}

  /** The events held so far, in the order they were tracked. */
  getEvents(): DeferredAnalyticsEvent[] { return this.events; }

  /** Forgets every held event. */
  clear(): void { this.events = []; }
}
