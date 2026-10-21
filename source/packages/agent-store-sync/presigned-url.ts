/**
 * The presigned address a store read or write is given.
 *
 * A presigned URL is an address with the authority to write, handed to us by someone else, so it is checked before it is
 * used and refused with the check it failed rather than followed anyway. The checks are, in the order they matter:
 *
 * - **it is an address at all** — an unparseable string is refused before anything looks at it;
 * - **it carries no credentials** — userinfo in the URL would be a password in a log line;
 * - **it is https** (or http on loopback, in development, which is the one case where the transport is the machine);
 * - **it is not somewhere private** — a loopback, private, link-local, carrier-grade or multicast address is refused even
 *   over https, because a presigned write to the host's own network is not a store write;
 * - **it is a store's own host** — an AWS S3 endpoint by default, or exactly one of the hosts the backend named.
 *
 * The refusal carries a redacted copy of the address (scheme, host and path only): the query is the signature, and a
 * signature in a message is a signature in a log.
 */
class RefusedStoreAddress extends Error {
  readonly code: string;
  readonly url: string;

  constructor(options: { readonly code: string; readonly message: string; readonly url: string }) {
    super(options.message);
    this.name = "RefusedStoreAddress";
    this.code = options.code;
    this.url = options.url;
  }
}

const refuseAddress = (code: string, message: string, url: URL): RefusedStoreAddress => new RefusedStoreAddress({ code, message, url: redactedAddress(url) });

/** What a refusal may show: everything but the query, which is the signature itself. */
function redactedAddress(url: URL | string): string {
  try {
    const parsed = typeof url === "string" ? new URL(url) : url;
    return `${parsed.protocol}//${parsed.host}${parsed.pathname}`;
  } catch {
    return "<unparseable-presigned-url>";
  }
}

function assertNoCredentials(url: URL): void {
  if (url.username !== "" || url.password !== "") throw refuseAddress("userinfo_not_allowed", "Refused presigned URL with embedded userinfo", url);
}

/** The host a URL names, without the brackets an IPv6 address is wrapped in. */
function bareHostname(url: URL): string {
  const hostname = url.hostname;
  return hostname.startsWith("[") && hostname.endsWith("]") ? hostname.slice(1, -1) : hostname;
}

const S3_OBJECT_LABELS = new Set(["s3", "s3-accelerate", "s3-fips"]);

/** An AWS S3 endpoint is an `amazonaws.com` name with an S3 label somewhere in it. */
function isS3Endpoint(hostname: string): boolean {
  const lowered = hostname.toLowerCase();
  if (lowered !== "amazonaws.com" && !lowered.endsWith(".amazonaws.com")) return false;
  return lowered.split(".").some((label) => S3_OBJECT_LABELS.has(label));
}

const LOOPBACK_HOSTNAMES = new Set(["localhost", "ip6-localhost", "127.0.0.1", "::1", "0:0:0:0:0:0:0:1"]);

function isLoopback(hostname: string): boolean {
  return LOOPBACK_HOSTNAMES.has(hostname.toLowerCase());
}

function isIPv4(hostname: string): boolean {
  const parts = hostname.split(".");
  if (parts.length !== 4) return false;
  return parts.every((part) => {
    if (part.length === 0 || part.length > 3 || !/^\d+$/.test(part)) return false;
    const value = Number(part);
    return Number.isInteger(value) && value >= 0 && value <= 255;
  });
}

/** The ranges a store's address may not be in: "this host", private networks, link-local, CGNAT, multicast and reserved. */
function isPrivateIPv4(hostname: string): boolean {
  const [first, second] = hostname.split(".").map(Number);
  if (first === undefined || second === undefined) return true;
  if (first === 0 || first === 10 || first === 127) return true;
  if (first === 169 && second === 254) return true;
  if (first === 172 && second >= 16 && second <= 31) return true;
  if (first === 192 && second === 168) return true;
  if (first === 100 && second >= 64 && second <= 127) return true;
  // Multicast and the reserved space above it have no business being a store either.
  return first >= 224;
}

/** IPv6 is private when it is unspecified, loopback, unique-local, link-local, multicast, or a private IPv4 in disguise. */
function isPrivateIPv6(hostname: string): boolean {
  const lowered = hostname.toLowerCase();
  if (lowered === "::" || lowered === "::1") return true;
  const mapped = ipv4Inside(lowered);
  if (mapped !== undefined) return isPrivateIPv4(mapped);
  return ["fc", "fd", "fe8", "fe9", "fea", "feb", "ff"].some((prefix) => lowered.startsWith(prefix));
}

/** The IPv4 address an IPv4-mapped IPv6 address carries, in either of the two ways it can be written. */
function ipv4Inside(hostname: string): string | undefined {
  const dotted = hostname.match(/^(?:0:0:0:0:0|::):?ffff:(\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3})$/i);
  if (dotted !== null) return dotted[1]!;
  if (!hostname.startsWith("::ffff:")) return undefined;
  const tail = hostname.slice("::ffff:".length);
  if (isIPv4(tail)) return tail;
  const hex = tail.match(/^([0-9a-f]{1,4}):([0-9a-f]{1,4})$/i);
  if (hex === null) return undefined;
  const high = Number.parseInt(hex[1]!, 16);
  const low = Number.parseInt(hex[2]!, 16);
  if (!Number.isFinite(high) || !Number.isFinite(low) || high < 0 || high > 65_535 || low < 0 || low > 65_535) return undefined;
  return `${(high >> 8) & 255}.${high & 255}.${(low >> 8) & 255}.${low & 255}`;
}

/** Whether an address is somewhere a store is never: this machine, a private network, or nothing at all. */
function isLocalOrInternal(hostname: string): boolean {
  if (hostname.length === 0) return true;
  if (isLoopback(hostname)) return true;
  if (isIPv4(hostname)) return isPrivateIPv4(hostname);
  if (hostname.includes(":")) return isPrivateIPv6(hostname);
  return false;
}

/** The default policy: no credentials, https, a public address, and an S3 endpoint. */
function assertStoreAddress(url: URL): void {
  assertNoCredentials(url);
  if (url.protocol !== "https:") throw refuseAddress("scheme_not_allowed", `Refused presigned URL with non-https scheme: ${url.protocol}`, url);
  const hostname = bareHostname(url);
  if (isLocalOrInternal(hostname)) throw refuseAddress("private_host_not_allowed", `Refused https presigned URL with private/internal host: ${hostname}`, url);
  if (!isS3Endpoint(hostname)) throw refuseAddress("host_not_allowed", `Refused presigned URL whose host is not an AWS S3 endpoint: ${hostname}`, url);
}

/** The default policy, plus "and it is one of these hosts". */
function allowlisting(hosts: readonly string[]): (url: URL) => void {
  const allowed = new Set(hosts.map((host) => host.toLowerCase()));
  return (url) => {
    assertStoreAddress(url);
    if (!allowed.has(url.hostname.toLowerCase())) throw refuseAddress("host_not_allowed", `Refused presigned URL whose host is not in the allowlist: ${url.hostname}`, url);
  };
}

const BCS_STORE_HOSTS = ["agent-stores.s3.us-east-1.amazonaws.com", "agent-stores.s3.amazonaws.com"];

const PLAYGROUND_STORE_HOSTS = ["agent-stores-928182716709-us-west-2-an.s3.us-west-2.amazonaws.com", "agent-stores-928182716709-us-west-2-an.s3.amazonaws.com"];

const assertBcsStoreAddress = (): ((url: URL) => void) => allowlisting(BCS_STORE_HOSTS);

/** A backend on this machine serves its own store over loopback http; everything else still has to be a real S3 endpoint. */
function localDevAddressValidator(): (url: URL) => void {
  const bcs = assertBcsStoreAddress();
  return (url) => {
    assertNoCredentials(url);
    if (url.protocol === "http:" && isLoopback(bareHostname(url))) return;
    bcs(url);
  };
}

function isLocalBackend(backendUrl: string): boolean {
  const trimmed = backendUrl.trim();
  return trimmed !== "" && (trimmed.includes("localhost") || trimmed.includes("lclhst.build"));
}

function isPlaygroundBackend(backendUrl: string): boolean {
  try {
    const hostname = new URL(backendUrl).hostname.toLowerCase();
    return hostname === "playground.cursor.sh" || hostname.endsWith(".playground.cursor.sh");
  } catch {
    return false;
  }
}

/** Which store hosts this backend's presigned addresses may name: its own, its playground's, or the default S3 endpoints. */
export function validatorForBackend(backendUrl: string): (url: URL) => void {
  if (isLocalBackend(backendUrl)) return localDevAddressValidator();
  if (isPlaygroundBackend(backendUrl)) return allowlisting(PLAYGROUND_STORE_HOSTS);
  return assertBcsStoreAddress();
}

/**
 * The check a store call makes before it uses an address: parse it, run the policy, and wrap a refusal with the file it
 * was for — the caller has the path, the policy only has the address.
 */
export function assertAddressSafe(args: { readonly rawUrl: string; readonly relPath: string; readonly validatePresignedUrl: (url: URL) => void }): void {
  let parsed: URL;
  try {
    parsed = new URL(args.rawUrl);
  } catch {
    throw new Error(`Refusing unparseable presigned URL for ${args.relPath}`);
  }
  try {
    args.validatePresignedUrl(parsed);
  } catch (error) {
    throw new Error(`Refusing presigned URL for ${args.relPath}: ${error instanceof Error ? error.message : String(error)}`, {
      cause: error instanceof Error ? error : undefined,
    });
  }
}
