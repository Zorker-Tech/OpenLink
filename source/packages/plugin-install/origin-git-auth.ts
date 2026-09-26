/**
 * The git configuration that carries a token to a plugin origin.
 *
 * A plugin artifact is fetched over git, and the fetch has to authenticate without a prompt: the token is put into a
 * basic-auth header for each host that serves the origin, together with the header that asks for reads from the origin
 * rather than from a mirror. Which hosts those are comes from the caller, since the platform's own plugin origin is not
 * defined yet; a token that is absent or empty produces no configuration at all rather than an unauthenticated one.
 */
/** The hosts the platform's own plugin origin is served from. None is defined yet, so the caller supplies them. */
export const ORIGIN_GIT_HOSTS = [] as const;
export const PREFER_ORIGIN_READS_HEADER = "x-prefer-origin-reads: true";

function buildTokenBasicAuthGitConfig(
  hosts: readonly string[],
  token: string | undefined,
): Record<string, string> | undefined {
  if (token === undefined || token.length === 0) return undefined;
  const header = `Authorization: Basic ${Buffer.from(
    `x-access-token:${token}`,
  ).toString("base64")}`;
  return Object.fromEntries(
    hosts.map(host => [`http.https://${host}/.extraheader`, header]),
  );
}

export function buildOriginTokenGitConfig(
  token: string | undefined,
  extraOriginHosts: readonly string[] = [],
): Record<string, string[]> | undefined {
  const trimmedExtra = extraOriginHosts.filter(host => host.trim() !== "");
  const hosts = trimmedExtra.length === 0
    ? ORIGIN_GIT_HOSTS
    : [...new Set([...ORIGIN_GIT_HOSTS, ...trimmedExtra])];
  const basicAuthConfig = buildTokenBasicAuthGitConfig(hosts, token);
  if (basicAuthConfig === undefined) return undefined;
  return Object.fromEntries(
    Object.entries(basicAuthConfig).map(([key, authHeader]) => [
      key,
      [authHeader, PREFER_ORIGIN_READS_HEADER],
    ]),
  );
}
