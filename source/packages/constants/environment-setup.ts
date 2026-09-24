/**
 * How long a prepared environment stays resumable.
 *
 * An environment that was set up once — dependencies installed, services started — can be resumed
 * instead of rebuilt, but not forever: the bounds below keep the promise short enough that a resume
 * is still cheaper than a rebuild, and the default sits inside them.
 */

const HOUR_MS = 60 * 60 * 1_000
const DAY_MS = 24 * HOUR_MS

export const DEFAULT_ENVIRONMENT_SETUP_MAX_RESUME_AGE_MS = 7 * DAY_MS
export const MIN_ENVIRONMENT_SETUP_MAX_RESUME_AGE_MS = 1 * HOUR_MS
export const MAX_ENVIRONMENT_SETUP_MAX_RESUME_AGE_MS = 30 * DAY_MS
