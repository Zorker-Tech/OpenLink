/** Provider model ids accepted for subagent tiers, kept at the catalog boundary. */
export const SLATE_SUBAGENT_MODEL_IDS = Object.freeze({
  standard: "composer-2.5",
  fast: "composer-2.5-fast",
})

const RENAMED_MODEL_ID = "composer-1.5"
const BUILT_IN_SUBAGENT_MODEL_PATTERN = /^composer-\d+(?:\.\d+)?(?:-fast)?$/

export function canonicalizeSubagentModelId(modelId: string): string {
  return modelId === RENAMED_MODEL_ID ? SLATE_SUBAGENT_MODEL_IDS.standard : modelId
}

export function isBuiltInSubagentModelId(modelId: string): boolean {
  return BUILT_IN_SUBAGENT_MODEL_PATTERN.test(canonicalizeSubagentModelId(modelId))
}
