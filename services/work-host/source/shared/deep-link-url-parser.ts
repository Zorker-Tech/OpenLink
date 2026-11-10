import {
  SLATE_DEEP_LINK_AUTHORITY,
  SLATE_DEEP_LINK_SCHEME,
  SLATE_HTTPS_DEEP_LINK_ORIGIN,
  type DeepLinkSource,
  type ParsedSlateDeepLink,
} from "./deep-link-contracts.ts";
import { isValidDeepLinkText } from "./deep-link-input-policy.ts";
import { parseDeepLinkRoute } from "./deep-link-route-parser.ts";

function sourceOf(raw: string): DeepLinkSource | null {
  const lowercase = raw.toLowerCase();
  if (lowercase.startsWith(`${SLATE_DEEP_LINK_SCHEME}:`)) return "protocol";
  return lowercase.startsWith("https:") ? "https" : null;
}

function parseUrl(raw: string): URL | null {
  try {
    return new URL(raw);
  } catch {
    return null;
  }
}

function usesNoCredentialsOrCustomPort(url: URL): boolean {
  return url.username === "" && url.password === "" && url.port === "";
}

function hasExpectedOrigin(url: URL, source: DeepLinkSource): boolean {
  if (source === "protocol") {
    return url.protocol === `${SLATE_DEEP_LINK_SCHEME}:` && url.host === SLATE_DEEP_LINK_AUTHORITY;
  }
  return url.protocol === "https:" && url.host === new URL(SLATE_HTTPS_DEEP_LINK_ORIGIN).host;
}

export function parseDeepLinkUrl(raw: unknown): ParsedSlateDeepLink | null {
  if (!isValidDeepLinkText(raw)) return null;
  const source = sourceOf(raw);
  if (source === null) return null;

  const url = parseUrl(raw);
  if (url === null || !usesNoCredentialsOrCustomPort(url) || !hasExpectedOrigin(url, source)) return null;
  return parseDeepLinkRoute(url, source);
}
