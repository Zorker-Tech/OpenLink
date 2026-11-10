/** The product analytics port, with a silent implementation for callers that do not collect any. */

/** What a tracked event may carry: whatever the surface chose to report, read only. */
type AnalyticsProperties = Readonly<Record<string, unknown>>;

/** The product analytics a host collects, if it collects any. */
export interface SlateProductAnalytics {
  trackEvent(event: string, props?: AnalyticsProperties): void;
}

/** An analytics port that collects nothing: every event is accepted and dropped. */
export function createNoopSlateProductAnalytics(): SlateProductAnalytics {
  return { trackEvent: () => {} };
}
