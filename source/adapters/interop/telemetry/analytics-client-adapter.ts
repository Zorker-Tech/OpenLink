/** Build the counterpart analytics client and keep credential outages from suppressing log delivery. */

import { AnalyticsService } from "../proto/generated/aiserver/v1/analytics_connect.ts"
import { createSlateBackendClient } from "../slate-backend/slate-backend-client.ts"
import type { StructuredLogClient } from "../../../shared/observability/structured-log-transport.ts"

export interface AnalyticsClientCredentials {
  readonly getAccessToken: (request: unknown) => Promise<string>
  readonly getMachineId: () => Promise<string>
}

export async function telemetryAuthToken(
  getAccessToken: AnalyticsClientCredentials["getAccessToken"],
  request: unknown,
): Promise<string> {
  try {
    return await getAccessToken(request)
  } catch {
    return ""
  }
}

export function createAnalyticsTelemetryClient(credentials: AnalyticsClientCredentials): StructuredLogClient {
  return createSlateBackendClient(AnalyticsService, {
    getAccessToken: request => telemetryAuthToken(credentials.getAccessToken, request),
    getMachineId: credentials.getMachineId,
  }) as unknown as StructuredLogClient
}
