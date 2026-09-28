/**
 * Where the platform decides when a token is refreshed.
 *
 * Nothing is decided here: the platform refreshes a token before it expires, and that policy lives with the token
 * itself. This module exists so the wiring has a place to name — an empty boundary rather than a missing one.
 */
// The shipped owner is an intentionally empty initialization boundary.
