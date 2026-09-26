/** The product analytics port, with a silent implementation for callers that do not collect any. */
export interface SlateProductAnalytics { trackEvent(name: string, properties?: Readonly<Record<string, unknown>>): void }
export function createNoopSlateProductAnalytics(): SlateProductAnalytics { return { trackEvent: () => {} }; }
