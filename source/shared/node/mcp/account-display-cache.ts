/**
 * Filling in the servers an account view could not resolve.
 *
 * A refresh of an account's MCP servers may resolve most of them and leave a few unresolved; the servers that are
 * still unresolved are carried over from the cached view rather than disappearing from it, since a server that is
 * merely slow is not a server that is gone. Anything the refresh did resolve replaces what was cached.
 */
export interface AccountDisplay<TServer> { readonly servers: TServer[]; readonly unresolvedServerIds?: string[] }

/** The ids a set of servers is keyed by. */
function serverIds<TServer extends { readonly id: string }>(listed: readonly TServer[]): Set<string> {
  return new Set(listed.map((server) => server.id));
}

/** The servers a refresh resolved, keyed by id. */
function resolvedServers<TServer extends { readonly id: string }>(refreshed: readonly TServer[]): Map<string, TServer> {
  return new Map(refreshed.map((server) => [server.id, server]));
}

/** The cached server to show: what the refresh resolved it to, or the cached one while it is still unresolved. */
function carriedOver<TServer extends { readonly id: string }>(cachedServer: TServer, resolved: ReadonlyMap<string, TServer>, unresolved: ReadonlySet<string>): TServer | undefined {
  const replacement = resolved.get(cachedServer.id);
  if (replacement != null) return replacement;
  return unresolved.has(cachedServer.id) ? cachedServer : undefined;
}

export function mergeUnresolvedAccountServers(display: any, cached: any): any;
export function mergeUnresolvedAccountServers<TServer extends { readonly id: string }>(view: AccountDisplay<TServer>, previous: AccountDisplay<TServer> | null): AccountDisplay<TServer> {
  if (previous == null || !view.unresolvedServerIds?.length) return view;
  const unresolved = new Set(view.unresolvedServerIds);
  const resolved = resolvedServers(view.servers);
  const previousIds = serverIds(previous.servers);
  const carried: TServer[] = [];
  for (const server of previous.servers) {
    const replacement = carriedOver(server, resolved, unresolved);
    if (replacement !== undefined) carried.push(replacement);
  }
  const added = view.servers.filter((server) => !previousIds.has(server.id));
  return { ...view, servers: [...carried, ...added] };
}