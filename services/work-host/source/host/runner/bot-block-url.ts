import { MAX_BLOCKED_HOST_LENGTH, MAX_BLOCKED_URL_LENGTH } from "./bot-block-contracts.ts";

export function parseBotBlockPageUrl(raw: string): URL | undefined {
  return URL.canParse(raw) ? new URL(raw) : undefined;
}

export function botBlockPageIdentity(url: URL, title: string) {
  return {
    hostname: url.hostname.toLowerCase().replace(/^www\./, ""),
    pathname: url.pathname,
    title: title.trim(),
  };
}

export function botBlockTelemetryLocation(url: URL): { blockedHost: string; blockedUrl: string } {
  return {
    blockedHost: url.hostname.toLowerCase().replace(/^www\./, "").slice(0, MAX_BLOCKED_HOST_LENGTH),
    blockedUrl: `${url.origin}${url.pathname}`.slice(0, MAX_BLOCKED_URL_LENGTH),
  };
}
