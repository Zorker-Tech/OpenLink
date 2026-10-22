/**
 * The pause before a smart-mode decision is taken, in development.
 *
 * The classifier is a network call, and in development it is worth seeing the state the decision is
 * made from before it is made; the delay is long enough to notice and short enough not to be in the
 * way.
 */

/** The pause in the unit a delay is waited in: ten seconds. */
export const DEV_SMART_MODE_CLASSIFIER_DELAY_MS = 10_000

/** The same pause in seconds, for what reads it as a number of seconds rather than milliseconds. */
export const DEV_SMART_MODE_CLASSIFIER_DELAY_SECONDS = DEV_SMART_MODE_CLASSIFIER_DELAY_MS / 1_000
