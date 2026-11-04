import { lookup } from "node:dns/promises";
import net from "node:net";
import { createDeadlinePolicy, realClock } from "../extensions/scheduling.ts";
import { hasNonPublicHostnameSuffix } from "../../shared/link-preview-policy.ts";
import { MAX_URL_LENGTH, SlateLinkPreviewError, type SafeConnectionTarget } from "./safe-link-preview-contracts.ts";

const BLOCKED_HOSTNAMES = new Set(["localhost"]);
const NON_PUBLIC_SUBNETS = [
  "0.0.0.0/8 ipv4", "10.0.0.0/8 ipv4", "100.64.0.0/10 ipv4", "127.0.0.0/8 ipv4",
  "169.254.0.0/16 ipv4", "172.16.0.0/12 ipv4", "192.0.0.0/24 ipv4", "192.0.2.0/24 ipv4",
  "192.88.99.0/24 ipv4", "192.168.0.0/16 ipv4", "198.18.0.0/15 ipv4", "198.51.100.0/24 ipv4",
  "203.0.113.0/24 ipv4", "224.0.0.0/4 ipv4", "240.0.0.0/4 ipv4", "::/127 ipv6",
  "64:ff9b::/96 ipv6", "64:ff9b:1::/48 ipv6", "100::/64 ipv6", "2001::/32 ipv6",
  "2001:db8::/32 ipv6", "2002::/16 ipv6", "fc00::/7 ipv6", "fe80::/10 ipv6",
  "fec0::/10 ipv6", "ff00::/8 ipv6",
] as const;

const nonPublicAddresses = new net.BlockList();
for (const entry of NON_PUBLIC_SUBNETS) {
  const separator = entry.indexOf(" ");
  const slash = entry.indexOf("/");
  const network = entry.slice(0, slash);
  const prefix = Number(entry.slice(slash + 1, separator));
  const family = entry.slice(separator + 1) as "ipv4" | "ipv6";
  nonPublicAddresses.addSubnet(network, prefix, family);
}
const LINK_PREVIEW_DNS_DEADLINE = createDeadlinePolicy(realClock, { name: "link-preview-dns-lookup", timeoutMs: 3_000 });

export function normalizeHostname(hostname: string): string {
  const withoutBrackets = hostname.startsWith("[") && hostname.endsWith("]")
    ? hostname.slice(1, -1)
    : hostname;
  return withoutBrackets.toLowerCase().replace(/\.$/, "");
}

export function isBlockedHostname(hostname: string): boolean {
  return hostname.length === 0
    || !hostname.includes(".")
    || BLOCKED_HOSTNAMES.has(hostname)
    || hasNonPublicHostnameSuffix(hostname);
}

export function isBlockedLinkPreviewIp(address: string): boolean {
  const family = net.isIP(address);
  if (family === 4) return nonPublicAddresses.check(address, "ipv4");
  if (family === 6) return nonPublicAddresses.check(address, "ipv6");
  return true;
}

export function parseSafeLinkPreviewUrl(rawUrl: string): URL {
  if (rawUrl.length > MAX_URL_LENGTH) throw new SlateLinkPreviewError("Link preview URL is too long.");
  let parsed: URL;
  try {
    parsed = new URL(rawUrl);
  } catch {
    throw new SlateLinkPreviewError("Link preview URL must be an absolute HTTPS URL.");
  }
  if (parsed.protocol !== "https:") throw new SlateLinkPreviewError("Link previews require HTTPS.");
  if (parsed.username !== "" || parsed.password !== "") throw new SlateLinkPreviewError("Link preview URLs cannot contain credentials.");
  if (parsed.port !== "" && parsed.port !== "443") throw new SlateLinkPreviewError("Link preview URLs cannot use a custom port.");

  const hostname = normalizeHostname(parsed.hostname);
  const family = net.isIP(hostname);
  if (family === 0 && isBlockedHostname(hostname)) throw new SlateLinkPreviewError("Link preview URL has a non-public hostname.");
  if (family !== 0 && isBlockedLinkPreviewIp(hostname)) throw new SlateLinkPreviewError("Link preview URL has a non-public IP address.");
  return parsed;
}

function hostHeaderFor(url: URL): string {
  const hostname = normalizeHostname(url.hostname);
  const formattedHost = net.isIP(hostname) === 6 ? `[${hostname}]` : hostname;
  return url.port === "" ? formattedHost : `${formattedHost}:${url.port}`;
}

export async function getSafeLinkPreviewConnectionTarget(
  url: URL,
  resolver: typeof lookup = lookup,
): Promise<SafeConnectionTarget> {
  const parsed = parseSafeLinkPreviewUrl(url.toString());
  const hostname = normalizeHostname(parsed.hostname);
  const family = net.isIP(hostname);
  if (family !== 0) return { connectHost: hostname, hostHeader: hostHeaderFor(parsed) };

  const addresses = await LINK_PREVIEW_DNS_DEADLINE.run(() => resolver(hostname, { all: true, verbatim: true }));
  if (addresses.length === 0) throw new SlateLinkPreviewError("Link preview hostname did not resolve.");
  if (addresses.some(({ address }) => isBlockedLinkPreviewIp(address))) {
    throw new SlateLinkPreviewError("Link preview hostname resolves to a non-public address.");
  }
  const pinned = addresses.find(({ family: addressFamily }) => addressFamily === 4)
    ?? addresses.find(({ family: addressFamily }) => addressFamily === 6)
    ?? addresses[0];
  if (pinned == null) throw new SlateLinkPreviewError("Link preview hostname did not resolve.");
  return { connectHost: pinned.address, hostHeader: hostHeaderFor(parsed), servername: hostname };
}

export function resolveSafeLinkPreviewRedirect(currentUrl: URL, location: string): URL {
  return parseSafeLinkPreviewUrl(new URL(location, currentUrl).toString());
}
