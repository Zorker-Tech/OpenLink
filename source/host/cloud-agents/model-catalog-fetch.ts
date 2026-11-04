/**
 * The model catalog, as the backend lists it for this account.
 *
 * The catalog is asked for with the parameters a turn would use, and what comes back is mapped into the platform's own
 * catalog entries — a model with no name is not one of them.
 */

import type { CatalogModel } from "../../shared/agents/model-catalog.ts";
import { fetchSlateModelCatalogFromInterop } from "../../adapters/interop/agent/model-catalog-adapter.ts";

export interface FetchSlateModelCatalogOptions {
  readonly getAccessToken: (options: { readonly backendUrl: string }) => Promise<string>;
  readonly getMachineId: () => Promise<string>;
  readonly onRequestId?: (requestId: string) => void;
}

export type FetchSlateModelCatalog = (options: FetchSlateModelCatalogOptions) => Promise<CatalogModel[]>;

/** Keep host settings out of the interop connection while preserving the host's credential callbacks. */
export function createSlateModelCatalogFetcher(
  fetchFromInterop: typeof fetchSlateModelCatalogFromInterop = fetchSlateModelCatalogFromInterop
): FetchSlateModelCatalog {
  return async options => fetchFromInterop({
    getAccessToken: options.getAccessToken,
    getMachineId: options.getMachineId,
    ...(options.onRequestId === undefined ? {} : { onRequestId: options.onRequestId })
  });
}

export const fetchSlateModelCatalog = createSlateModelCatalogFetcher();
