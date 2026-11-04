import type { AnalyticsBatchRequest, AnalyticsEventProperty } from "../../../packages/analytics-client/events.ts"
import type { AnalyticsBufferClient, AnalyticsBufferTokenProvider } from "../../../packages/analytics-client/buffer.ts"
import { AnalyticsService } from "../proto/generated/aiserver/v1/analytics_connect.ts"
import { AnalyticsEvent, EventData, TrackEventsRequest } from "../proto/generated/aiserver/v1/analytics_pb.ts"
import { createSlateCursorBackendClient, getSlateInferenceBackendUrl, type SlateInferenceOptions } from "../cursor-backend/cursor-inference.ts"

export interface AnalyticsWireClient {
  trackEvents(request: TrackEventsRequest, options: { readonly signal: AbortSignal }): Promise<unknown>
}

function eventDataToWire(value: AnalyticsEventProperty): EventData {
  if (typeof value === "string") return new EventData({ data: { case: "stringValue", value } })
  if (typeof value === "number") return new EventData({ data: { case: "doubleValue", value } })
  if (typeof value === "boolean") return new EventData({ data: { case: "boolValue", value } })
  if (typeof value === "bigint") return new EventData({ data: { case: "intValue", value } })
  throw new TypeError("unsupported Slate analytics event property")
}

export function encodeAnalyticsBatch(request: AnalyticsBatchRequest): TrackEventsRequest {
  return new TrackEventsRequest({
    events: request.events.map((event) => new AnalyticsEvent({
      eventName: event.eventName,
      eventData: Object.fromEntries(
        Object.entries(event.eventData).map(([key, value]) => [key, eventDataToWire(value)]),
      ),
      timestamp: event.timestamp,
    })),
  })
}

export function createAnalyticsBufferWireClient(client: AnalyticsWireClient): AnalyticsBufferClient {
  return {
    trackEvents: (request, options) => client.trackEvents(encodeAnalyticsBatch(request), options),
  }
}

export function createSlateAnalyticsClient(
  options: Omit<SlateInferenceOptions, "backendUrl">,
): AnalyticsBufferClient {
  const client = createSlateCursorBackendClient(AnalyticsService, options)
  return createAnalyticsBufferWireClient(client)
}

/** Supplies the analytics credential at the counterpart endpoint boundary. */
export function createSlateAnalyticsTokenProvider(
  getAccessToken: (options: { backendUrl: string }) => Promise<string>,
  backendUrl = getSlateInferenceBackendUrl(),
): AnalyticsBufferTokenProvider {
  return {
    async getAccessToken() {
      try {
        const token = await getAccessToken({ backendUrl })
        return token.length > 0 ? token : null
      } catch {
        return null
      }
    },
  }
}
