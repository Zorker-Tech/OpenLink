/** The update tracks a build can follow, and how one is recognized. */
export const SLATE_UPDATE_TRACKS = ["stable", "nightly", "dogfood"] as const;

/** One of the tracks a build may follow. */
export type SlateUpdateTrack = (typeof SLATE_UPDATE_TRACKS)[number];

/** The tracks as a set, so recognition is one lookup rather than a chain of comparisons. */
const UPDATE_TRACKS: ReadonlySet<string> = new Set(SLATE_UPDATE_TRACKS);

/** Whether a value names one of the tracks a build may follow. */
export function isSlateUpdateTrack(value: unknown): value is SlateUpdateTrack {
  return typeof value === "string" && UPDATE_TRACKS.has(value);
}
