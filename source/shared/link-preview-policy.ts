/**
 * Whether a host is one the platform will not fetch a preview from.
 *
 * Names that only resolve inside a network — a machine on the same LAN, a service in a cluster, an address on the
 * onion network — are not public, and a preview of one would be a request the user did not mean to make.
 */
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

export function hasNonPublicHostnameSuffix(hostname: string): boolean {
  return NON_PUBLIC_HOSTNAME_SUFFIXES.some(
    (suffix) => hostname === suffix.slice(1) || hostname.endsWith(suffix),
  );
}
