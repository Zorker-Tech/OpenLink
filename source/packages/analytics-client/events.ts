export type AnalyticsEventProperty = string | number | boolean | bigint
export type AnalyticsEventProperties = Readonly<Record<string, unknown>>

export interface BufferedAnalyticsEvent {
  readonly eventName: string
  readonly eventData: Readonly<Record<string, AnalyticsEventProperty>>
  readonly timestamp: bigint
}

export interface AnalyticsBatchRequest {
  readonly events: readonly BufferedAnalyticsEvent[]
}
