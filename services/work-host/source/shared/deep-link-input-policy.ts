import { SLATE_DEEP_LINK_MAX_LENGTH } from "./deep-link-contracts.ts";

function printableAsciiOnly(value: string): boolean {
  for (const character of value) {
    const code = character.charCodeAt(0);
    if (code < 33 || code > 126) return false;
  }
  return true;
}

function percentEscapesAreComplete(value: string): boolean {
  return !/%(?![0-9A-Fa-f]{2})/.test(value);
}

function pathUsesLiteralCanonicalSegments(raw: string): boolean {
  const queryAt = raw.indexOf("?");
  const pathAndAuthority = queryAt < 0 ? raw : raw.slice(0, queryAt);
  return !pathAndAuthority.includes("%") && !/\/\.{1,2}(?:\/|$)/.test(pathAndAuthority);
}

export function isValidDeepLinkText(value: unknown): value is string {
  if (typeof value !== "string" || value.length === 0 || value.length > SLATE_DEEP_LINK_MAX_LENGTH) return false;
  if (!printableAsciiOnly(value) || value.includes("#") || value.includes("\\")) return false;
  return percentEscapesAreComplete(value) && pathUsesLiteralCanonicalSegments(value);
}
