/**
 * Where an MCP server may send a user to authenticate.
 *
 * A server's authorization URL is followed by the platform, so only an address the user can trust is accepted: https
 * anywhere, and plain http only when both the authorization URL and the server it belongs to are on this machine — a
 * plain-http address anywhere else could be read or rewritten on the way.
 */
export const CATALOG_CACHE_TTL_MS = 30_000;
export const isLoopbackHostname = (hostname: string): boolean => hostname === "localhost" || hostname === "127.0.0.1";
export function validateAuthorizationUrl(authUrl: string, serverUrl?: string): string | undefined { let parsed: URL; try { parsed = new URL(authUrl.trim()); } catch { return undefined; } if (parsed.protocol === "https:") return parsed.toString(); if (parsed.protocol === "http:" && isLoopbackHostname(parsed.hostname)) { try { const server = serverUrl == null ? undefined : new URL(serverUrl); if (server != null && isLoopbackHostname(server.hostname)) return parsed.toString(); } catch {} } return undefined; }
