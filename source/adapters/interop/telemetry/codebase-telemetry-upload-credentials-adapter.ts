import { createSlateChecksum } from "../slate-backend/slate-backend-client.ts";
import { getSlateBackendClientHeaders } from "../backend/slate-client-metadata-adapter.ts";

/** Projects Slate account identity into the upload credential envelope expected by the remote helper. */
export async function createCodebaseTelemetryUploadCredentialsAdapter(options: {
  readonly credentials: { readonly authToken: string };
  readonly auth: { getMachineId(): Promise<string> };
}): Promise<{ authToken: string; requestHeaders: Record<string, string> }> {
  const machineId = await options.auth.getMachineId();
  return {
    authToken: options.credentials.authToken,
    requestHeaders: {
      ...getSlateBackendClientHeaders(),
      "x-cursor-checksum": createSlateChecksum(machineId),
      "x-ghost-mode": "false",
    },
  };
}
