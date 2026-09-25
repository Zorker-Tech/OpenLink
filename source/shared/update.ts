/** The update tracks a build can follow, and how one is recognized. */
export const SLATE_UPDATE_TRACKS = ["stable", "nightly", "dogfood"] as const;
export type SlateUpdateTrack = (typeof SLATE_UPDATE_TRACKS)[number];

export function isSlateUpdateTrack(value: unknown): value is SlateUpdateTrack {
  return value === "stable" || value === "nightly" || value === "dogfood";
}
