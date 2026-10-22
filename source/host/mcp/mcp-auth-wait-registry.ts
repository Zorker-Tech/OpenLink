/**
 * Remembering that an agent is waiting for a connector to be authorized.
 *
 * A wait is keyed by the connector's name, normalized so that the spelling the platform uses and the one the connector
 * reports match, or by the server id when there is no name. A completion takes the wait it matches — an id match wins
 * over a name match — and waits that outlive their time are dropped.
 */

/** How long a wait lives when the caller does not say. */
export const DEFAULT_MCP_AUTH_WAIT_TTL_MS = 60 * 60 * 1_000;

/** A connector's name as a wait is keyed by it: lower case, letters and digits only. */
export function normalizeConnectorName(value: string): string {
  return value.toLowerCase().replace(/[^a-z0-9]/g, "");
}

/** Who a completion says it is, and which server it is for. */
export interface McpAuthCompletionIdentity {
  readonly serverId: string;
  readonly serverName: string;
}

/** A wait as it is kept: the agent waiting, the server it waits on when the wait has an id, and when it expires. */
interface WaitingAuth {
  agentId: string;
  serverId: string | null;
  expiresAtMs: number;
}

/** A server id, or null when there is none to key a wait by. */
function usableServerId(serverId: string | null | undefined): string | null {
  return serverId != null && serverId.length > 0 ? serverId : null;
}

/** The key a wait is kept under: the normalized connector name, or the server id when there is no name. */
function waitKeyFor(connector: string, serverId: string | null): string | null {
  const nameKey = normalizeConnectorName(connector);
  if (nameKey.length > 0) return nameKey;
  return serverId != null ? `id:${serverId}` : null;
}

/** The auth waits this process has recorded. */
export class McpAuthWaitRegistry {
  readonly #waiting = new Map<string, WaitingAuth>();
  readonly #timeToLiveMs: number;
  readonly #clock: () => number;

  constructor(options?: { readonly ttlMs?: number; readonly now?: () => number }) {
    this.#timeToLiveMs = options?.ttlMs ?? DEFAULT_MCP_AUTH_WAIT_TTL_MS;
    this.#clock = options?.now ?? Date.now;
  }

  /** Records that an agent waits for this connector's authorization, replacing whatever was kept under the same key. */
  register(event: { readonly agentId: string; readonly connector: string; readonly serverId?: string | null }): void {
    this.prune();
    const serverId = usableServerId(event.serverId);
    const key = waitKeyFor(event.connector, serverId);
    if (key == null) return;
    this.#waiting.set(key, { agentId: event.agentId, serverId, expiresAtMs: this.#clock() + this.#timeToLiveMs });
  }

  /** Takes the wait a completion matches, preferring a server-id match over a name match, and answers the waiting agent. */
  take(completion: McpAuthCompletionIdentity): string | null {
    this.prune();
    const nameKey = normalizeConnectorName(completion.serverName);
    const matching = [...this.#waiting].filter(([key, entry]) => waitMatches(entry, key, completion, nameKey));
    for (const [key] of matching) this.#waiting.delete(key);
    const byServerId = matching.findLast(([, entry]) => entry.serverId != null);
    const byName = matching.findLast(([, entry]) => entry.serverId == null);
    const taken = byServerId ?? byName;
    return taken?.[1].agentId ?? null;
  }

  /** Drops every wait that has outlived its time. */
  prune(): void {
    const expiredAtOrBefore = this.#clock();
    for (const [key, entry] of [...this.#waiting]) if (entry.expiresAtMs <= expiredAtOrBefore) this.#waiting.delete(key);
  }
}

/** Whether a kept wait is the one this completion is for: its server id, or its name when it has no id. */
function waitMatches(kept: WaitingAuth, key: string, completion: McpAuthCompletionIdentity, nameKey: string): boolean {
  if (kept.serverId != null) return kept.serverId === completion.serverId;
  return nameKey.length > 0 && key === nameKey;
}
