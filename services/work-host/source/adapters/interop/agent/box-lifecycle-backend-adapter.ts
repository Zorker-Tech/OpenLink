/** Project the generated box lifecycle RPCs onto the host-owned lifecycle port. */

import { SlateBotService } from "../proto/generated/aiserver/v1/slate_bot_connect.ts";
import { createSlateBackendClient } from "../slate-backend/slate-backend-client.ts";
import type { BoxLifecycleBackend, BoxLifecycleOutcome } from "../../../host/boxes/box-lifecycle/box-lifecycle-service.ts";

export interface BoxLifecycleAuth {
  readonly getAccessToken: (options: { readonly backendUrl: string }) => Promise<string>;
  readonly getMachineId: () => Promise<string>;
}

interface BoxLifecycleWireClient {
  getBoxRunState(input: Record<string, never>, options: { readonly signal: AbortSignal }): Promise<{
    readonly imageUpdateAvailable: boolean;
  }>;
  recreateBox(input: { readonly preserveData: boolean; readonly force: boolean }): Promise<BoxLifecycleOutcome>;
}

export function createBoxLifecycleBackendFromClient(client: BoxLifecycleWireClient): BoxLifecycleBackend {
  return {
    async imageUpdateAvailable(signal) {
      const state = await client.getBoxRunState({}, { signal });
      return state.imageUpdateAvailable;
    },
    async recreate(input) {
      const result = await client.recreateBox(input);
      return {
        started: result.started,
        ...(result.reason === undefined ? {} : { reason: result.reason }),
      };
    },
  };
}

export function createBoxLifecycleBackend(auth: BoxLifecycleAuth): BoxLifecycleBackend {
  const client = createSlateBackendClient(SlateBotService, {
    getAccessToken: auth.getAccessToken,
    getMachineId: auth.getMachineId,
  }) as unknown as BoxLifecycleWireClient;
  return createBoxLifecycleBackendFromClient(client);
}
