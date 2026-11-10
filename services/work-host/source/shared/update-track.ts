/**
 * Which update tracks a build can follow.
 *
 * The nightly track is not offered while it is disabled, the internal tracks are only offered to those who asked for
 * them, and a track that cannot be selected is still shown when it is the one the build is actually on — a user is
 * never left without seeing where they are. A track that is not selectable is coerced to one that is, and what a
 * managed configuration names is only accepted when it survives that coercion.
 */

/** The tracks a build can be on, from the calmest to the most eager. */
export const SLATE_UPDATE_TRACKS = ["stable", "nightly", "dogfood"] as const;

export type SlateUpdateTrack = (typeof SLATE_UPDATE_TRACKS)[number];

/** Whether the nightly track is offered at all: it is off while it is not ready for general use. */
export const NIGHTLY_UPDATE_TRACK_DISABLED = true;

/** The tracks that are only offered to a build that asked for internal tracks. */
const INTERNAL_TRACKS: readonly SlateUpdateTrack[] = ["dogfood"];

/** The track that can be disabled, named once. */
const NIGHTLY_TRACK: SlateUpdateTrack = "nightly";

/** The track a build falls back to when nothing else says otherwise. */
const DEFAULT_TRACK: SlateUpdateTrack = "stable";

/** Every track, for membership questions. */
const ALL_TRACKS: ReadonlySet<SlateUpdateTrack> = new Set(SLATE_UPDATE_TRACKS);

/** What a settings screen knows when it lists the tracks it may offer. */
interface AvailableTracksQuery {
  readonly unlockInternalTracks: boolean;
  readonly effectiveTrack: SlateUpdateTrack;
}

/** What a managed configuration may say about the track and the internal tracks. */
interface ReleaseTrackConfig {
  readonly releaseTrack?: unknown;
  readonly unlockInternalTracks?: unknown;
}

/** What a build knows about its own track: what was managed, what the user chose, and what the build was built as. */
interface EffectiveTrackInput {
  readonly managedTrack?: SlateUpdateTrack;
  readonly userOverride?: SlateUpdateTrack;
  readonly buildDefault?: SlateUpdateTrack | null;
}

/** What a managed configuration turns into. */
interface ReleaseTrackGate {
  readonly managedTrack: SlateUpdateTrack | undefined;
  readonly unlockInternalTracks: boolean;
}

/** Whether this track is offered at all: the nightly one only while it is enabled. */
function isOffered(track: SlateUpdateTrack): boolean {
  return !(NIGHTLY_UPDATE_TRACK_DISABLED && track === NIGHTLY_TRACK);
}

/** Whether this track is only for a build that asked for internal tracks. */
function isInternal(track: SlateUpdateTrack): boolean {
  return INTERNAL_TRACKS.includes(track);
}

/** The tracks a user may pick: the offered ones, with the internal ones only when they were unlocked. */
export function selectableUpdateTracks(unlockInternalTracks: boolean): SlateUpdateTrack[] {
  return SLATE_UPDATE_TRACKS.filter((candidate) => isOffered(candidate) && (!isInternal(candidate) || unlockInternalTracks));
}

/** The tracks a settings screen lists: what can be selected, plus the track the build is already on. */
export function availableUpdateTracks(input: AvailableTracksQuery): SlateUpdateTrack[] {
  const selectable = new Set(selectableUpdateTracks(input.unlockInternalTracks));
  return SLATE_UPDATE_TRACKS.filter((candidate) => selectable.has(candidate) || candidate === input.effectiveTrack);
}

/** Whether this value names a track this build knows. */
export function isSlateUpdateTrack(candidate: unknown): candidate is SlateUpdateTrack {
  return typeof candidate === "string" && ALL_TRACKS.has(candidate as SlateUpdateTrack);
}

/** The nearest track that can be followed: the nightly one is not offered, so it becomes the default one. */
export function coerceToEnabledTrack(track: SlateUpdateTrack): SlateUpdateTrack {
  return track === NIGHTLY_TRACK ? DEFAULT_TRACK : track;
}

/** A stored track, accepted only when it names one and survives coercion; anything else is not a managed track. */
export function toManagedUpdateTrack(stored: unknown): SlateUpdateTrack | undefined {
  if (typeof stored !== "string") return undefined;
  const track = stored.trim();
  if (!isSlateUpdateTrack(track)) return undefined;
  return coerceToEnabledTrack(track) === track ? track : undefined;
}

/** What a managed configuration says about the track, with the unlock flag read strictly. */
export function resolveReleaseTrackGate(config: ReleaseTrackConfig): ReleaseTrackGate {
  return { managedTrack: toManagedUpdateTrack(config.releaseTrack), unlockInternalTracks: config.unlockInternalTracks === true };
}

/** The track a build follows: the managed one, then the user's, then the build's own, then the default. */
export function resolveEffectiveTrack(input: EffectiveTrackInput): SlateUpdateTrack {
  return coerceToEnabledTrack(input.managedTrack ?? input.userOverride ?? input.buildDefault ?? DEFAULT_TRACK);
}
