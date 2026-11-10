/**
 * Whether a hostname names something inside a network rather than on the public internet.
 *
 * A link preview of such a name would be a request the user did not mean to make: it resolves only on the user's own
 * network, in a cluster, or on an overlay such as the onion network.
 */

/** The suffixes a name can carry and still stay inside a network. */
export const NON_PUBLIC_HOSTNAME_SUFFIXES = [
  ".localhost",
  ".local",
  ".internal",
  ".lan",
  ".home",
  ".corp",
  ".cluster",
  ".svc",
  ".arpa",
  ".onion",
] as const;

/** The same names without their leading dot, so that a bare "localhost" is recognised as well as "printer.localhost". */
const BARE_NON_PUBLIC_HOSTNAMES: ReadonlySet<string> = new Set(NON_PUBLIC_HOSTNAME_SUFFIXES.map((suffix) => suffix.slice(1)));

/** Whether a hostname only resolves inside a network rather than on the public internet. */
export function hasNonPublicHostnameSuffix(candidate: string): boolean {
  if (BARE_NON_PUBLIC_HOSTNAMES.has(candidate)) return true;
  for (const suffix of NON_PUBLIC_HOSTNAME_SUFFIXES) {
    if (candidate.endsWith(suffix)) return true;
  }
  return false;
}
