/** Translate the account model response into Slate's selectable catalog. */

import { AiService } from "../proto/generated/aiserver/v1/aiserver_connect.ts"
import {
  AvailableModelsRequest,
  AvailableModelsScope,
  type AvailableModelsResponse,
} from "../proto/generated/aiserver/v1/aiserver_pb.ts"
import { createSlateCursorBackendClient } from "../cursor-backend/cursor-inference.ts"
import type { CatalogModel, ModelParameter } from "../../../shared/agents/model-catalog.ts"

type InteropAvailableModel = AvailableModelsResponse["models"][number]
type InteropParameterDefinition = InteropAvailableModel["parameterDefinitions"][number]

/** The one RPC this adapter uses to read the account catalog. */
export interface ModelCatalogClient {
  availableModels(request: AvailableModelsRequest): Promise<AvailableModelsResponse>
}

/** The credentials needed to call the account's model service. */
export interface ModelCatalogConnection {
  readonly getAccessToken: (options: { readonly backendUrl: string }) => Promise<string>
  readonly getMachineId: () => Promise<string>
  readonly onRequestId?: (requestId: string) => void
}

/** A display label is useful only when it contains something visible. */
function trimmedOrUndefined(value: string | undefined): string | undefined {
  const trimmed = value?.trim()
  return trimmed !== undefined && trimmed.length > 0 ? trimmed : undefined
}

/** One selectable parameter from the remote catalog, or nothing when it has no values. */
function projectParameter(definition: InteropParameterDefinition): ModelParameter | null {
  const booleanDefinition = definition.parameterType?.booleanParameter
  const enumDefinition = definition.parameterType?.enumParameter
  const values = (booleanDefinition?.values ?? enumDefinition?.values ?? []).map((option) => {
    const displayName = trimmedOrUndefined(option.displayName)
    return { value: option.value, ...(displayName === undefined ? {} : { displayName }) }
  })
  if (values.length === 0) return null

  const name = trimmedOrUndefined(definition.name)
  return {
    id: definition.id,
    ...(name === undefined ? {} : { name }),
    type: booleanDefinition != null ? "boolean" : "enum",
    values,
  }
}

/** Convert one external model while keeping only choices Slate knows how to validate. */
export function projectAvailableModel(model: InteropAvailableModel): CatalogModel {
  const displayName = trimmedOrUndefined(model.clientDisplayName)
  return {
    id: model.name,
    ...(displayName === undefined ? {} : { displayName }),
    aliases: [...model.idAliases],
    params: model.parameterDefinitions
      .map(projectParameter)
      .filter((parameter): parameter is ModelParameter => parameter !== null),
    variants: model.variants.map((variant) => variant.parameterValues.map(({ id, value }) => ({ id, value }))),
  }
}

/** Empty backend names are unusable; all other entries cross into the Slate model. */
export function projectAvailableModels(models: readonly InteropAvailableModel[]): CatalogModel[] {
  return models.filter((model) => model.name.trim().length > 0).map(projectAvailableModel)
}

/** Testable request path: the transport seam stays inside the interop package. */
export async function fetchSlateModelCatalogWithClient(client: ModelCatalogClient): Promise<CatalogModel[]> {
  const response = await client.availableModels(new AvailableModelsRequest({
    useModelParameters: true,
    doNotUseMarkdown: true,
    scope: AvailableModelsScope.USER_AVAILABLE,
  }))
  return projectAvailableModels(response.models)
}

/** Build the external RPC client here so generated service and message types do not escape this adapter. */
export async function fetchSlateModelCatalogFromInterop(connection: ModelCatalogConnection): Promise<CatalogModel[]> {
  const client = createSlateCursorBackendClient(AiService, connection)
  return fetchSlateModelCatalogWithClient(client)
}
