/** How long an agent's own data is kept, and how often the sweep that removes it runs. */

/** How long an agent's own data is kept before the sweep may remove it: thirty days. */
export const DEFAULT_AGENT_DATA_TTL_MS = 30 * 24 * 60 * 60 * 1_000;

/** How often the sweep that removes data past that age runs: once a day. */
export const DEFAULT_AGENT_DATA_CLEANUP_INTERVAL_MS = 24 * 60 * 60 * 1_000;
