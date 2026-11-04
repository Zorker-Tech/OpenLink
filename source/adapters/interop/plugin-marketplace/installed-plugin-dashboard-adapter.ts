/** Translate generated account-dashboard requests and responses into Slate's installed-plugin port. */
import type { Client } from "@connectrpc/connect";

import { DashboardService } from "../proto/generated/aiserver/v1/dashboard_connect.ts";
import {
  GetEffectiveUserPluginsRequest,
  GetEffectiveUserPluginsResponse,
  GetMeRequest,
} from "../proto/generated/aiserver/v1/dashboard_pb.ts";
import { createSlateCursorBackendClient, getSlateInferenceBackendUrl } from "../cursor-backend/cursor-inference.ts";
import type { SlatePluginDashboardPort, EffectivePluginsResponse } from "../../../packages/plugin-install/backend-marketplace-client.ts";

type DashboardRpcClient = Pick<Client<typeof DashboardService>, "getEffectiveUserPlugins" | "getMe">;

function slatePluginListing(response: GetEffectiveUserPluginsResponse): EffectivePluginsResponse {
  const value = response.toJson();
  if (value === null || typeof value !== "object" || Array.isArray(value)) return {};
  return value as EffectivePluginsResponse;
}

/** Keep request messages and service method names on this side of the boundary. */
export function adaptInstalledPluginDashboard(client: DashboardRpcClient): SlatePluginDashboardPort {
  return {
    async listEffectivePlugins(options) {
      const response = await client.getEffectiveUserPlugins(new GetEffectiveUserPluginsRequest(), { timeoutMs: options.timeoutMs });
      return slatePluginListing(response);
    },
    async readCurrentUser(options) {
      const response = await client.getMe(new GetMeRequest(), { timeoutMs: options.timeoutMs });
      return { userId: response.userId };
    },
  };
}

/** Build the interop-backed reader from Slate's account-auth port. */
export function createSlatePluginDashboardPort(auth: {
  getAccessToken(args: { backendUrl: string }): Promise<string>;
  getMachineId(): Promise<string>;
}): SlatePluginDashboardPort {
  const backendUrl = getSlateInferenceBackendUrl();
  const client = createSlateCursorBackendClient(DashboardService, {
    getAccessToken: async () => await auth.getAccessToken({ backendUrl }),
    getMachineId: auth.getMachineId,
  });
  return adaptInstalledPluginDashboard(client);
}
