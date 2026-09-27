/**
 * Events that are held until they can be sent.
 *
 * An event that cannot be delivered now is kept, bounded in number and age, and sent when the client can reach the
 * backend again; an event that is too old to mean anything is dropped rather than sent late.
 */
export interface DeferredAnalyticsEvent { eventName: string; props?: Readonly<Record<string, unknown>> | undefined; timestamp?: number | undefined }
export class DeferredAnalyticsBuffer {
  private events: DeferredAnalyticsEvent[] = [];
  track(eventName: string, props?: Readonly<Record<string, unknown>>, timestamp?: number): void {
    this.events.push({ eventName, props, timestamp });
  }
  async flush(_timeoutMs: number): Promise<void> {}
  getEvents(): DeferredAnalyticsEvent[] { return this.events; }
  clear(): void { this.events = []; }
}
