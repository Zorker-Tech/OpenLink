/**
 * Filling in the servers an account view could not resolve.
 *
 * A refresh of an account's MCP servers may resolve most of them and leave a few unresolved; the servers that are
 * still unresolved are carried over from the cached view rather than disappearing from it, since a server that is
 * merely slow is not a server that is gone. Anything the refresh did resolve replaces what was cached.
 */
export interface AccountDisplay<TServer> { readonly servers: TServer[]; readonly unresolvedServerIds?: string[] }
export function mergeUnresolvedAccountServers(display: any, cached: any): any;
export function mergeUnresolvedAccountServers<TServer extends { readonly id: string }>(display: AccountDisplay<TServer>, cached: AccountDisplay<TServer> | null): AccountDisplay<TServer> { if (cached == null || !display.unresolvedServerIds?.length) return display; const unresolved = new Set(display.unresolvedServerIds), fresh = new Map(display.servers.map((server) => [server.id, server])), cachedIds = new Set(cached.servers.map((server) => server.id)); return { ...display, servers: [...cached.servers.flatMap((server) => { const replacement = fresh.get(server.id); return replacement != null ? [replacement] : unresolved.has(server.id) ? [server] : []; }), ...display.servers.filter((server) => !cachedIds.has(server.id))] }; }
