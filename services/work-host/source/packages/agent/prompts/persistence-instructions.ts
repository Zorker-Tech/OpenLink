/** Whether a model needs the longer guidance for completing multi-step work. */

export interface PersistenceModelInfo {
  readonly needsLongRunningWorkGuidance?: boolean | undefined;
}

export function usesPersistenceInstructions(modelInfo: PersistenceModelInfo | null | undefined): boolean {
  return modelInfo?.needsLongRunningWorkGuidance === true;
}
