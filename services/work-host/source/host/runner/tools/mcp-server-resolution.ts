/**
 * Finding an MCP server by the identifier it is known by, or by the id an older version used.
 *
 * The identifier is what the platform files a server under, and an older id is still accepted for callers that hold
 * one; a listing that cannot be read is reported as unreadable rather than as an empty one.
 */

/** A server the platform has installed, as a listing returns it. */
export interface McpInstalledServer { readonly id: string; readonly serverIdentifier: string; readonly [key: string]: unknown }

/** The rows whose identifier is exactly this one, or, when none is, the rows whose older id is. */
export function resolveMcpServerRowsByIdentifierOrLegacyId<T extends McpInstalledServer>(rows: readonly T[], token: string): T[] {
  const wanted = token.trim();
  if (!wanted) return [];
  const byIdentifier = rows.filter((row) => row.serverIdentifier === wanted);
  if (byIdentifier.length > 0) return byIdentifier;
  return rows.filter((row) => row.id === wanted);
}

/** The first row the identifier or the older id resolves to, or null when nothing does. */
export const resolveMcpServerRowByIdentifierOrLegacyId = <T extends McpInstalledServer>(rows: readonly T[], token: string): T | null =>
  resolveMcpServerRowsByIdentifierOrLegacyId(rows, token)[0] ?? null;

/** What reading a listing answers: the servers, or the fact that it could not be read. */
type McpInstalledListing<T> = { kind: "read"; servers: readonly T[] } | { kind: "unreadable" };

/** The servers a listing holds, or a word for a listing that could not be read. */
export async function readMcpInstalledListing<T>(load: () => Promise<readonly T[]>): Promise<McpInstalledListing<T>> {
  try {
    return { kind: "read", servers: await load() };
  } catch {
    return { kind: "unreadable" };
  }
}
