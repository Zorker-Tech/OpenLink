/**
 * How long a watch for a server's authentication waits.
 *
 * A server that is being authenticated is polled rather than waited on forever: each poll is bounded, the whole watch
 * is bounded, and a watch is identified by the server and the account together, since the same server authenticated
 * under two accounts is two different things to wait for.
 */
export const AUTH_WATCH_POLL_INTERVAL_MS = 5_000;
export const AUTH_WATCH_TIMEOUT_MS = 15 * 60 * 1_000;
export const AUTH_WATCH_POLL_TIMEOUT_MS = 30_000;
export function authWatchKey(serverId: string, accountKey: string): string { return `${serverId}::${accountKey}`; }
