/**
 * Where an MCP server may send a user to authenticate.
 *
 * A server's authorization URL is followed by the platform, so only an address the user can trust is accepted: https
 * anywhere, and plain http only when both the authorization URL and the server it belongs to are on this machine — a
 * plain-http address anywhere else could be read or rewritten on the way.
 */
export const CATALOG_CACHE_TTL_MS = 30_000;

/** Whether a hostname names this machine itself. */
export const isLoopbackHostname = (hostname: string): boolean => hostname === "localhost" || hostname === "127.0.0.1";

/** The address a text names, or nothing when the text is not an address. */
function addressOf(value: string): URL | undefined {
  try {
    return new URL(value);
  } catch {
    return undefined;
  }
}

/** Whether the server an authorization URL belongs to is one on this machine. */
function serverIsLocal(serverUrl: string | undefined): boolean {
  if (serverUrl == null) return false;
  const server = addressOf(serverUrl);
  return server !== undefined && isLoopbackHostname(server.hostname);
}

export function validateAuthorizationUrl(authUrl: string, serverUrl?: string): string | undefined {
  const auth = addressOf(authUrl.trim());
  if (auth === undefined) return undefined;
  if (auth.protocol === "https:") return auth.toString();
  if (auth.protocol !== "http:" || !isLoopbackHostname(auth.hostname)) return undefined;
  return serverIsLocal(serverUrl) ? auth.toString() : undefined;
}
