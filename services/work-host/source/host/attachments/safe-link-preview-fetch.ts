/** Resolve safe redirects around one byte-bounded HTTPS request. */
import {
  MAX_REDIRECTS,
  SlateLinkPreviewError,
  type LinkPreviewFetchOptions,
  type LinkPreviewResponse,
} from "./safe-link-preview-contracts.ts";
import { parseSafeLinkPreviewUrl, resolveSafeLinkPreviewRedirect } from "./safe-link-preview-target.ts";
import { fetchLinkPreviewOnce, firstLinkPreviewHeaderValue, isLinkPreviewRedirect } from "./safe-link-preview-transport.ts";

export {
  LINK_PREVIEW_USER_AGENT,
  MAX_REDIRECTS,
  MAX_URL_LENGTH,
  SlateLinkPreviewError,
} from "./safe-link-preview-contracts.ts";
export type { LinkPreviewFetchOptions, LinkPreviewResponse, SafeConnectionTarget } from "./safe-link-preview-contracts.ts";
export {
  getSafeLinkPreviewConnectionTarget,
  isBlockedHostname,
  isBlockedLinkPreviewIp,
  normalizeHostname,
  parseSafeLinkPreviewUrl,
  resolveSafeLinkPreviewRedirect,
} from "./safe-link-preview-target.ts";

export async function fetchSafeLinkPreviewResource(
  rawUrl: string,
  options: LinkPreviewFetchOptions,
): Promise<LinkPreviewResponse> {
  let currentUrl = parseSafeLinkPreviewUrl(rawUrl);
  const redirectUrls: string[] = [];
  for (let redirectCount = 0; ; redirectCount += 1) {
    if (redirectCount > MAX_REDIRECTS) throw new SlateLinkPreviewError("Too many redirects while fetching link preview.");
    const response = await fetchLinkPreviewOnce(currentUrl, options);
    if (!isLinkPreviewRedirect(response.statusCode)) {
      return { ...response, finalUrl: currentUrl.toString(), redirectUrls };
    }

    const location = firstLinkPreviewHeaderValue(response.headers.location);
    if (location == null) return { ...response, finalUrl: currentUrl.toString(), redirectUrls };
    currentUrl = resolveSafeLinkPreviewRedirect(currentUrl, location);
    redirectUrls.push(currentUrl.toString());
  }
}
