/**
 * How a permission request from an older version is summarized now that it can no longer be acted on.
 */

/** What the summary says first: this request is from an older version and cannot be acted on. */
const LEGACY_SUMMARY_PREFIX = "Legacy permission request (no longer actionable):";

/** The dash that separates a request's title from its reason. */
const TITLE_REASON_SEPARATOR = "\u2014";

/** A permission request as an older version stored it. */
interface LegacyPermissionRequest {
  readonly title: string;
  readonly reason: string;
}

/** One line about a permission request that can no longer be acted on. */
export const summarizePermissionRequest = (request: LegacyPermissionRequest): string =>
  `${LEGACY_SUMMARY_PREFIX} ${request.title} ${TITLE_REASON_SEPARATOR} ${request.reason}`;
