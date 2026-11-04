import { parseDeepLinkUrl } from "./deep-link-url-parser.ts";
import type { ParsedSlateDeepLink } from "./deep-link-contracts.ts";

export {
  SLATE_DEEP_LINK_AUTHORITY,
  SLATE_DEEP_LINK_MAX_LENGTH,
  SLATE_DEEP_LINK_SCHEME,
  SLATE_HTTPS_DEEP_LINK_ORIGIN,
  SLATE_HTTPS_DEEP_LINK_PATH_PREFIX,
  SLATE_OPEN_DEEP_LINK_URL,
  type ParsedSlateDeepLink,
  type SlateDeepLink,
} from "./deep-link-contracts.ts";
export { canonicalSlateDeepLinkUrl } from "./deep-link-canonical.ts";

export function parseSlateDeepLink(raw: unknown): ParsedSlateDeepLink | null {
  return parseDeepLinkUrl(raw);
}
