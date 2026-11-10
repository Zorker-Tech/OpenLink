/**
 * How long a watch for a server's authentication waits.
 *
 * A server that is being authenticated is polled rather than waited on forever: each poll is bounded, the whole watch
 * is bounded, and a watch is identified by the server and the account together, since the same server authenticated
 * under two accounts is two different things to wait for.
 */

/** One minute, in the milliseconds the watch lengths are given in. */
const MINUTE_MS = 60 * 1_000;

/** How often a watch polls the server it is watching. */
export const AUTH_WATCH_POLL_INTERVAL_MS = 5_000;

/** How long a whole watch may take before it gives up. */
export const AUTH_WATCH_TIMEOUT_MS = 15 * MINUTE_MS;

/** How long one poll of a watch may take. */
export const AUTH_WATCH_POLL_TIMEOUT_MS = 30_000;

/** The key a watch is kept under: the server and the account it is authenticated under. */
export function authWatchKey(server: string, account: string): string {
  return [server, account].join("::");
}
