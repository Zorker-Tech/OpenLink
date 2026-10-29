import type {
  CloudAgentApi,
  CloudModelCatalogEntry,
} from "./cloud-agent-tool-contracts.ts"

function catalogIndex(catalog: readonly CloudModelCatalogEntry[]): ReadonlyMap<string, CloudModelCatalogEntry> {
  const index = new Map<string, CloudModelCatalogEntry>()
  for (const model of catalog) {
    for (const name of [model.id, ...model.aliases]) {
      const normalized = name.toLowerCase()
      if (!index.has(normalized)) index.set(normalized, model)
    }
  }
  return index
}

function parameterErrors(
  model: CloudModelCatalogEntry,
  selected: Readonly<Record<string, string>>,
): string[] {
  const definitions = new Map(model.params.map(parameter => [parameter.id, parameter]))
  return Object.entries(selected).flatMap(([id, value]) => {
    const definition = definitions.get(id)
    if (definition === undefined) return [`Unknown parameter '${id}'.`]
    if (definition.values.some(option => option.value === value)) return []
    const choices = definition.values.map(option => option.value).join(", ")
    return [`Invalid value '${value}' for '${id}' (allowed: ${choices}).`]
  })
}

/** The caller-facing, ordered view of models and the choices each model accepts. */
export function modelCatalogLines(catalog: readonly CloudModelCatalogEntry[]): string[] {
  return catalog.flatMap(model => {
    const name = [
      `- ${model.id}`,
      ...(model.displayName ? [`(${model.displayName})`] : []),
      ...(model.aliases.length > 0 ? [`[aliases: ${model.aliases.join(", ")}]`] : []),
    ].join(" ")
    return [
      name,
      ...model.params.map(parameter => `    ${parameter.id}: ${parameter.values.map(option => option.value).join(" | ")}`),
      ...(model.incompatibilities ?? []).map(note => `    (restriction) ${note}`),
    ]
  })
}

/** Returns a validation message, leaving an unavailable catalog decision to the manager. */
export async function validateModelSelection(
  api: Pick<CloudAgentApi, "listModels">,
  modelId?: string,
  modelParams?: Readonly<Record<string, string>>,
): Promise<string | null> {
  const selectedId = modelId?.trim() ?? ""
  const selectedParams = modelParams != null && Object.keys(modelParams).length > 0
    ? modelParams
    : undefined
  if (selectedId === "") {
    return selectedParams === undefined
      ? null
      : "'model' is required when 'model_params' are provided."
  }

  let catalog: CloudModelCatalogEntry[]
  try {
    catalog = await api.listModels()
  } catch {
    return null
  }

  const model = catalogIndex(catalog).get(selectedId.toLowerCase())
  if (model === undefined) {
    const available = catalog.map(entry => entry.id).join(", ")
    return `Unknown model '${modelId}'. Use the 'models' action to list valid models. Available: ${available}.`
  }

  const issues = selectedParams === undefined ? [] : parameterErrors(model, selectedParams)
  return issues.length === 0 ? null : `Invalid model_params for ${model.id}: ${issues.join(" ")}`
}
