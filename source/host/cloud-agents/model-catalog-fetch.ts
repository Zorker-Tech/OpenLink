/**
 * The model catalog, as the backend lists it for this account.
 *
 * The catalog is asked for with the parameters a turn would use, and what comes back is mapped into the platform's own
 * catalog entries — a model with no name is not one of them.
 */

import { AiService } from "../../packages/proto/generated/aiserver/v1/aiserver_connect.ts";
import { AvailableModelsRequest, AvailableModelsScope, type AvailableModelsResponse } from "../../packages/proto/generated/aiserver/v1/aiserver_pb.ts";
import { mapAvailableModels, type CatalogModel } from "../../shared/agents/model-catalog.ts";
import { createSlateCursorBackendClient } from "../../shared/node/cursor-backend/cursor-inference.ts";

/** The one backend call this read makes; a caller may hand one in instead of building it. */
export interface ModelCatalogClient {
  availableModels(request: AvailableModelsRequest): Promise<AvailableModelsResponse>;
}

export interface FetchSlateModelCatalogOptions {
  readonly getAccessToken: (options: { readonly backendUrl: string }) => Promise<string>;
  readonly getMachineId: () => Promise<string>;
  readonly onRequestId?: (requestId: string) => void;
  readonly client?: ModelCatalogClient;
}

export async function fetchSlateModelCatalog(options: FetchSlateModelCatalogOptions): Promise<CatalogModel[]> {
  const client = options.client ?? createSlateCursorBackendClient(AiService, options);
  const response = await client.availableModels(new AvailableModelsRequest({
    useModelParameters: true,
    doNotUseMarkdown: true,
    scope: AvailableModelsScope.USER_AVAILABLE,
  }));
  return mapAvailableModels(response.models);
}
