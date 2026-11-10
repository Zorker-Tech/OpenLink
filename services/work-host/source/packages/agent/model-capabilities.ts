/**
 * What a model is, as Slate's own prompt and tool policy sees it.
 *
 * The flags name capabilities, not a vendor family. External model metadata is translated into this shape
 * at the interop boundary; product modules never read the external field names.
 */

export interface SlateModelCapabilities {
  readonly promptVersion: string
  readonly isLegacyAgentModel1?: boolean
  readonly isLegacyAgentModel15?: boolean
  readonly isLegacyAgentModel2?: boolean
  readonly isLegacyAgentMatterhorn?: boolean
  readonly isRawTrainingSlug?: boolean
  readonly [key: string]: unknown
}

export function createSlateModelCapabilities(
  input: Partial<SlateModelCapabilities> & { readonly promptVersion?: string } = {},
): SlateModelCapabilities {
  return {
    ...input,
    promptVersion: input.promptVersion ?? "latest",
  }
}

/** Reads only the Slate-named flags; an absent value is not a capability. */
export function hasSlateModelCapability(
  value: SlateModelCapabilities | undefined,
  capability: "isLegacyAgentModel1" | "isLegacyAgentModel15" | "isLegacyAgentModel2" | "isLegacyAgentMatterhorn",
): boolean {
  return value?.[capability] === true
}
