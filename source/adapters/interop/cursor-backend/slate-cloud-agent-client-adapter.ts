/** Binds the cloud-agent and dashboard service schemas to Slate's cloud-agent ports. */
import { BackgroundComposerService } from "../proto/generated/aiserver/v1/background_composer_connect.ts"
import { DashboardService } from "../proto/generated/aiserver/v1/dashboard_connect.ts"
import { createSlateCursorBackendClient } from "./cursor-inference.ts"
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
  return createSlateCursorBackendClient(BackgroundComposerService, clientOptions(bindings)) as unknown as CloudAgentClient
}

export function createSlateCloudAgentDashboardClient(bindings: ClientBindings): DashboardClient {
  return createSlateCursorBackendClient(DashboardService, clientOptions(bindings)) as unknown as DashboardClient
}
