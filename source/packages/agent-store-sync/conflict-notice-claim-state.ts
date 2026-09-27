/**
 * The event ids an agent store has already announced.
 *
 * What was announced is remembered so the same event is not acted on twice, and the memory is bounded: once it is
 * full, the oldest eighth is dropped in one go rather than one at a time.
 */
export const MAX_ANNOUNCED_EVENT_IDS = 65_536;
export const ANNOUNCED_EVICTION_BATCH = Math.max(1, Math.floor(MAX_ANNOUNCED_EVENT_IDS / 8));
