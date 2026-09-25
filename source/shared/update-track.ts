/**
 * Which update tracks a build can follow.
 *
 * The nightly track is not offered while it is disabled, the internal tracks are only offered to those who asked for
 * them, and a track that cannot be selected is still shown when it is the one the build is actually on — a user is
 * never left without seeing where they are. A track that is not selectable is coerced to one that is, and what a
 * managed configuration names is only accepted when it survives that coercion.
 */
export const SLATE_UPDATE_TRACKS = ["stable", "nightly", "dogfood"] as const;
export type SlateUpdateTrack = (typeof SLATE_UPDATE_TRACKS)[number];
export const NIGHTLY_UPDATE_TRACK_DISABLED = true;
const INTERNAL_UPDATE_TRACKS: readonly SlateUpdateTrack[] = ["dogfood"];
export function selectableUpdateTracks(unlockInternalTracks: boolean): SlateUpdateTrack[] { return SLATE_UPDATE_TRACKS.filter((track) => !(NIGHTLY_UPDATE_TRACK_DISABLED && track === "nightly") && (!INTERNAL_UPDATE_TRACKS.includes(track) || unlockInternalTracks)); }
export function availableUpdateTracks(input: { readonly unlockInternalTracks: boolean; readonly effectiveTrack: SlateUpdateTrack }): SlateUpdateTrack[] { const selectable = selectableUpdateTracks(input.unlockInternalTracks); return SLATE_UPDATE_TRACKS.filter((track) => selectable.includes(track) || track === input.effectiveTrack); }
export function isSlateUpdateTrack(value: unknown): value is SlateUpdateTrack { return typeof value === "string" && (SLATE_UPDATE_TRACKS as readonly string[]).includes(value); }
export function coerceToEnabledTrack(track: SlateUpdateTrack): SlateUpdateTrack { return track === "nightly" ? "stable" : track; }
export function toManagedUpdateTrack(value: unknown): SlateUpdateTrack | undefined { if (typeof value !== "string") return undefined; const track = value.trim(); return isSlateUpdateTrack(track) && coerceToEnabledTrack(track) === track ? track : undefined; }
export function resolveReleaseTrackGate(config: { readonly releaseTrack?: unknown; readonly unlockInternalTracks?: unknown }) { return { managedTrack: toManagedUpdateTrack(config.releaseTrack), unlockInternalTracks: config.unlockInternalTracks === true }; }
export function resolveEffectiveTrack(input: { readonly managedTrack?: SlateUpdateTrack; readonly userOverride?: SlateUpdateTrack; readonly buildDefault?: SlateUpdateTrack | null }): SlateUpdateTrack { return coerceToEnabledTrack(input.managedTrack ?? input.userOverride ?? input.buildDefault ?? "stable"); }
