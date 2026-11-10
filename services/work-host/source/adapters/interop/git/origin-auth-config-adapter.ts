/** Build Git's per-origin extra-header configuration for plugin downloads. */

export const ORIGIN_GIT_HOSTS = [] as const
export const PREFER_ORIGIN_READS_HEADER = "x-prefer-origin-reads: true"

function authenticationHeader(token: string): string {
  const encoded = Buffer.from(`x-access-token:${token}`).toString("base64")
  return `Authorization: Basic ${encoded}`
}

function originHosts(extraHosts: readonly string[]): string[] {
  const supplied = extraHosts.filter(host => host.trim().length > 0)
  if (supplied.length === 0) return [...ORIGIN_GIT_HOSTS]
  return [...new Set([...ORIGIN_GIT_HOSTS, ...supplied])]
}

function entryForHost(host: string, authorization: string): [string, string[]] {
  return [`http.https://${host}/.extraheader`, [authorization, PREFER_ORIGIN_READS_HEADER]]
}

export function buildOriginTokenGitConfig(
  token: string | undefined,
  extraOriginHosts: readonly string[] = [],
): Record<string, string[]> | undefined {
  if (token === undefined || token.length === 0) return undefined
  const authorization = authenticationHeader(token)
  return Object.fromEntries(originHosts(extraOriginHosts).map(host => entryForHost(host, authorization)))
}
