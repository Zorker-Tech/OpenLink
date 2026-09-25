/**
 * Whether a model is given the persistence instructions.
 *
 * One family of models reads a particular wording of "keep going until the work is done" better than
 * the general one, and the platform words the instructions differently for it. Which family a model
 * belongs to arrives as flags on its catalogue entry, and any one of them is enough: the family flag
 * itself, or any of the generations that are known to take the same wording.
 */

export interface PersistenceModelInfo {
  readonly isGpt5?: boolean | undefined
  readonly isGpt5Family?: boolean | undefined
  readonly isGpt51?: boolean | undefined
  readonly isGpt52?: boolean | undefined
  readonly isGpt54?: boolean | undefined
  readonly isGpt55?: boolean | undefined
  readonly isGpt56?: boolean | undefined
  readonly isGpt52Codex?: boolean | undefined
  readonly isGpt53Codex?: boolean | undefined
  readonly isGpt53CodexSpark?: boolean | undefined
}

export function usesPersistenceInstructions(modelInfo: PersistenceModelInfo | null | undefined): boolean {
  return modelInfo?.isGpt5 === true ||
    modelInfo?.isGpt5Family === true ||
    modelInfo?.isGpt51 === true ||
    modelInfo?.isGpt52 === true ||
    modelInfo?.isGpt54 === true ||
    modelInfo?.isGpt55 === true ||
    modelInfo?.isGpt56 === true ||
    modelInfo?.isGpt52Codex === true ||
    modelInfo?.isGpt53Codex === true ||
    modelInfo?.isGpt53CodexSpark === true
}
