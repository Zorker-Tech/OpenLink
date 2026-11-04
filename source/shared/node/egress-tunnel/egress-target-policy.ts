import { lookup as dnsLookup } from "node:dns/promises";
import { isIP } from "node:net";

export function isSharedCgnat(octets: readonly number[]): boolean {
  return octets[0] === 100 && (((octets[1] ?? 0) & 192) === 64);
}

export function isReservedV4(octets: readonly number[]): boolean {
  return (octets[0] === 192 && octets[1] === 0 && octets[2] === 0)
    || (octets[0] === 198 && (((octets[1] ?? 0) & 254) === 18))
    || (octets[0] ?? 0) >= 240;
}

function dottedTail(value: string): { readonly prefix: string; readonly words: number[] } | null {
  const matched = /^(.*:)(\d+\.\d+\.\d+\.\d+)$/.exec(value);
  if (matched?.[1] == null || matched[2] == null) return null;
  const octets = matched[2].split(".").map((part) => Number.parseInt(part, 10));
  if (octets.some((octet) => Number.isNaN(octet) || octet < 0 || octet > 255)) return null;
  return {
    prefix: matched[1],
    words: [((octets[0] ?? 0) << 8) | (octets[1] ?? 0), ((octets[2] ?? 0) << 8) | (octets[3] ?? 0)],
  };
}

function parseHexWords(value: string): number[] {
  return value.split(":").filter(Boolean).map((word) => Number.parseInt(word, 16));
}

export function expandV6(ip: string): number[] | null {
  let normalized = (ip.split("%")[0] ?? "").toLowerCase();
  let trailingWords: number[] = [];
  const dotted = dottedTail(normalized);
  if (dotted != null) {
    trailingWords = dotted.words;
    normalized = dotted.prefix;
  }

  const halves = normalized.split("::");
  if (halves.length > 2) return null;
  const leading = parseHexWords(halves[0] ?? "");
  const trailing = halves.length === 2 ? parseHexWords(halves[1] ?? "") : [];
  if (leading.some(Number.isNaN) || trailing.some(Number.isNaN)) return null;

  if (halves.length === 2) {
    const zeroWords = 8 - leading.length - trailing.length - trailingWords.length;
    return zeroWords < 0
      ? null
      : [...leading, ...Array<number>(zeroWords).fill(0), ...trailing, ...trailingWords];
  }

  const complete = [...leading, ...trailingWords];
  return complete.length === 8 ? complete : null;
}

export function embeddedV4(words: readonly number[]): number[] | null {
  const lastFourOctets = (): number[] => [
    (words[6] ?? 0) >> 8,
    (words[6] ?? 0) & 255,
    (words[7] ?? 0) >> 8,
    (words[7] ?? 0) & 255,
  ];
  if (words.slice(0, 5).every((word) => word === 0) && words[5] === 65_535) return lastFourOctets();
  if (words[0] === 100 && words[1] === 65_435 && words.slice(2, 6).every((word) => word === 0)) {
    return lastFourOctets();
  }
  if (words.slice(0, 6).every((word) => word === 0) && !(words[6] === 0 && (words[7] ?? 0) <= 1)) {
    return lastFourOctets();
  }
  return null;
}

export function isBlockedV4(octets: readonly number[]): boolean {
  const first = octets[0] ?? 0;
  const second = octets[1] ?? 0;
  const isPrivate = first === 10
    || (first === 172 && second >= 16 && second <= 31)
    || (first === 192 && second === 168);
  return isPrivate
    || first === 127
    || (first === 169 && second === 254)
    || octets.every((octet) => octet === 255)
    || (first === 192 && second === 0 && octets[2] === 2)
    || (first === 198 && second === 51 && octets[2] === 100)
    || (first === 203 && second === 0 && octets[2] === 113)
    || octets.every((octet) => octet === 0)
    || (first >= 224 && first <= 239)
    || isSharedCgnat(octets)
    || isReservedV4(octets);
}

export function isBlockedV6(ip: string): boolean {
  const words = expandV6(ip);
  if (words == null) return true;
  const v4 = embeddedV4(words);
  if (v4 != null) return isBlockedV4(v4);

  const firstWord = words[0] ?? 0;
  return (words.slice(0, 7).every((word) => word === 0) && words[7] === 1)
    || words.every((word) => word === 0)
    || (firstWord & 65_280) === 65_280
    || (firstWord & 65_024) === 64_512
    || (firstWord & 65_472) === 65_152;
}

export function isBlockedIp(ip: string): boolean {
  const family = isIP(ip);
  if (family === 4) return isBlockedV4(ip.split(".").map(Number));
  if (family === 6) return isBlockedV6(ip);
  return true;
}

export async function resolveChecked(
  host: string,
  allowPrivate: boolean,
  lookup: typeof dnsLookup = dnsLookup,
): Promise<string | null> {
  if (isIP(host) !== 0) return allowPrivate || !isBlockedIp(host) ? host : null;

  let addresses: Array<{ address: string; family: number }>;
  try {
    addresses = await lookup(host, { all: true }) as Array<{ address: string; family: number }>;
  } catch {
    return null;
  }
  for (const answer of addresses) if (allowPrivate || !isBlockedIp(answer.address)) return answer.address;
  return null;
}
