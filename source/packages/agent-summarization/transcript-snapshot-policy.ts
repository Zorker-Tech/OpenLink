const APPROXIMATE_CHARACTERS_PER_TOKEN = 4;
const MINIMUM_SNAPSHOT_CHARACTERS = 50_000;
const MAXIMUM_SNAPSHOT_CHARACTERS = 3_200_000;

export const DEFAULT_TRANSCRIPT_SNAPSHOT_SHARE = 0.02;

export function maximumTranscriptSnapshotChars(
  contextWindowTokens: number | undefined,
  share: number,
): number {
  if (
    contextWindowTokens === undefined
    || !Number.isFinite(contextWindowTokens)
    || contextWindowTokens <= 0
    || !Number.isFinite(share)
    || share <= 0
  ) {
    return MINIMUM_SNAPSHOT_CHARACTERS;
  }

  const estimate = Math.floor(
    contextWindowTokens * share * APPROXIMATE_CHARACTERS_PER_TOKEN,
  );
  return Math.max(
    MINIMUM_SNAPSHOT_CHARACTERS,
    Math.min(MAXIMUM_SNAPSHOT_CHARACTERS, estimate),
  );
}
