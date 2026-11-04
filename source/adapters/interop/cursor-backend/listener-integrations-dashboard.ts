import type { MethodInfoUnary } from "@bufbuild/protobuf"

import { DashboardService } from "../proto/generated/aiserver/v1/dashboard_connect.ts"
import {
  GetScmConnectionStatusRequest,
  type GetScmConnectionStatusResponse,
  GetSlackInstallUrlRequest,
  type GetSlackInstallUrlResponse,
  GetSlackUserSettingsRequest,
  type GetSlackUserSettingsResponse,
} from "../proto/generated/aiserver/v1/dashboard_pb.ts"
import { createSlateCursorBackendClient } from "./cursor-inference.ts"

/** The destination provided by the counterpart when no direct install link is available. */
export const DASHBOARD_INTEGRATIONS_URL = "https://cursor.com/dashboard?tab=integrations"

export interface ListenerDashboardAuth {
  getAccessToken(args: { readonly backendUrl: string }): Promise<string>
  getMachineId(): Promise<string>
}

export interface ListenerDashboardWireClient {
  getSlackUserSettings(request: GetSlackUserSettingsRequest): Promise<GetSlackUserSettingsResponse>
  getScmConnectionStatus(request: GetScmConnectionStatusRequest): Promise<GetScmConnectionStatusResponse>
  getSlackInstallUrl(request: GetSlackInstallUrlRequest): Promise<GetSlackInstallUrlResponse>
}

export function adaptListenerDashboardClient(client: ListenerDashboardWireClient) {
  return {
    getSlackUserSettings: () => client.getSlackUserSettings(new GetSlackUserSettingsRequest({})),
    getScmConnectionStatus: () => client.getScmConnectionStatus(new GetScmConnectionStatusRequest({})),
    getSlackInstallUrl: () => client.getSlackInstallUrl(new GetSlackInstallUrlRequest({})),
  }
}

/** Bind our listener reads to the counterpart's generated dashboard RPC methods. */
export function createListenerIntegrationsDashboard(auth: ListenerDashboardAuth) {
  const service = DashboardService as typeof DashboardService & {
    readonly methods: typeof DashboardService.methods & {
      readonly getSlackUserSettings: MethodInfoUnary<GetSlackUserSettingsRequest, GetSlackUserSettingsResponse>
      readonly getScmConnectionStatus: MethodInfoUnary<GetScmConnectionStatusRequest, GetScmConnectionStatusResponse>
      readonly getSlackInstallUrl: MethodInfoUnary<GetSlackInstallUrlRequest, GetSlackInstallUrlResponse>
    }
  }
  const client = createSlateCursorBackendClient(service, {
    getAccessToken: auth.getAccessToken,
    getMachineId: auth.getMachineId,
  })
  return adaptListenerDashboardClient(client)
}
