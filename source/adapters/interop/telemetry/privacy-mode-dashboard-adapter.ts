/** Translate the account dashboard's privacy-mode RPC into Slate's telemetry privacy value. */
import type { MethodInfoUnary } from "@bufbuild/protobuf";
import { DashboardService } from "../proto/generated/aiserver/v1/dashboard_connect.ts";
import { GetUserPrivacyModeRequest, type GetUserPrivacyModeResponse } from "../proto/generated/aiserver/v1/dashboard_pb.ts";
import { createSlateCursorBackendClient } from "../cursor-backend/cursor-inference.ts";
import { PrivacyMode as SlatePrivacyMode, type PrivacyMode } from "../../../packages/redaction/privacy-mode.ts";
import { privacyModeFromWire, privacyModeToWire } from "./privacy-mode-wire-adapter.ts";

type DashboardWithPrivacyMode = typeof DashboardService & {
  readonly methods: typeof DashboardService.methods & {
    readonly getUserPrivacyMode: MethodInfoUnary<GetUserPrivacyModeRequest, GetUserPrivacyModeResponse>;
  };
};

interface PrivacyModeRpcClient {
  getUserPrivacyMode(request: GetUserPrivacyModeRequest, options: { readonly signal: AbortSignal }): Promise<GetUserPrivacyModeResponse>;
}

/** Read a mode using a generated request, then translate the enum before leaving interop. */
export async function readSlatePrivacyModeFromDashboard(
  client: PrivacyModeRpcClient,
  args: { readonly signal: AbortSignal },
): Promise<PrivacyMode> {
  const response = await client.getUserPrivacyMode(
    new GetUserPrivacyModeRequest({ inferredPrivacyMode: privacyModeToWire(SlatePrivacyMode.NO_STORAGE) }),
    { signal: args.signal },
  );
  return privacyModeFromWire(response.privacyMode);
}

/** Create the transport reader at the only boundary that knows the dashboard service shape. */
export function createSlatePrivacyModeDashboardReader(authApi: { readonly getMachineId: () => Promise<string> }) {
  return (args: { readonly auth: { readonly authToken: string }; readonly signal: AbortSignal }) => {
    const service = DashboardService as DashboardWithPrivacyMode;
    const client = createSlateCursorBackendClient(service, {
      getAccessToken: async () => args.auth.authToken,
      getMachineId: () => authApi.getMachineId(),
    });
    return readSlatePrivacyModeFromDashboard(client, { signal: args.signal });
  };
}
