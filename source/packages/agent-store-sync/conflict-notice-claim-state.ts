/**
 * The event ids an agent store has already announced.
 *
 * What was announced is remembered so the same event is not acted on twice, and the memory is bounded: once it is
 * full, the oldest eighth is dropped in one go rather than one at a time.
 */

/** How many announced event ids are remembered before old ones are dropped. */
export const MAX_ANNOUNCED_EVENT_IDS = 65_536;

/** The remembered ids are dropped in eighths of the memory. */
const EVICTION_DIVISOR = 8;

/** The number of ids dropped at once: an eighth of the memory, and never none. */
function evictionBatchFor(maxRemembered: number): number {
  return Math.max(1, Math.floor(maxRemembered / EVICTION_DIVISOR));
}

/** How many ids are dropped at once when the memory is full. */
export const ANNOUNCED_EVICTION_BATCH = evictionBatchFor(MAX_ANNOUNCED_EVENT_IDS);
