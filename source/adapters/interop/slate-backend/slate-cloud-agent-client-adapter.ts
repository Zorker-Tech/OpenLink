/** Binds the cloud-agent and dashboard service schemas to Slate's cloud-agent ports. */
import { BackgroundComposerService } from "../proto/generated/aiserver/v1/background_composer_connect.ts"
import { DashboardService } from "../proto/generated/aiserver/v1/dashboard_connect.ts"
import { createSlateBackendClient } from "./slate-backend-client.ts"
import type {
  CloudAgentClient,
  DashboardClient,
  SlateCloudAgentManagerOptions,
} from "../../../host/cloud-agents/cloud-agent-manager-contracts.ts"

type ClientBindings = Pick<SlateCloudAgentManagerOptions, "getAccessToken" | "getMachineId" | "onRequestId">

function clientOptions(bindings: ClientBindings) {
  return {
    getAccessToken: bindings.getAccessToken,
    getMachineId: bindings.getMachineId,
    ...(bindings.onRequestId === undefined ? {} : { onRequestId: bindings.onRequestId }),
  }
}

export function createSlateCloudAgentClient(bindings: ClientBindings): CloudAgentClient {
  return createSlateBackendClient(BackgroundComposerService, clientOptions(bindings)) as unknown as CloudAgentClient
}

export function createSlateCloudAgentDashboardClient(bindings: ClientBindings): DashboardClient {
  return createSlateBackendClient(DashboardService, clientOptions(bindings)) as unknown as DashboardClient
}
