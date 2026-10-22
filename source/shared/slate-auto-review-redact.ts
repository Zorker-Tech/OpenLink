/**
 * Taking secrets out of what the auto-review classifier is shown.
 *
 * A command or a patch may carry a credential, and the classifier is shown what it needs to judge without being shown
 * the credential itself: a URL is cut down to its origin and path, a value that looks like a token is replaced, and a
 * key whose name says it holds a secret has its value replaced however it was spelled.
 */

/** The secret-value shapes this platform recognizes: a bearer token by scheme, or one of the known token prefixes. */
export const SLATE_AUTO_REVIEW_SECRET_VALUE_PATTERN =
  /^(?:bearer\s+|sk[-_]|gh[pousr]_|xox[baprs]-|AIza)[^\s]*$/i;

/** A key name that says its value is a secret. */
export const SLATE_AUTO_REVIEW_SECRET_KEY_PATTERN =
  /(?:auth|credential|key|password|secret|signature|token)/i;

/** Where a URL starts in a text; it runs until whitespace or a quote. */
const URL_IN_TEXT = /https?:\/\/[^\s"'\`]+/gi;

/** The credentials a URL may carry before its host: the `user:password@` part. */
const URL_CREDENTIALS = /^(https?:\/\/)[^/?#]*@/i;

/** A key that holds a secret, followed by the value to replace however it was spelled. */
const KEYED_SECRET_VALUE =
  /((?:--)?(?:api[_-]?key|authorization|credential|password|secret|signature|token)\s*(?:=|:|\s)\s*)(?:"[^"]*"|'[^']*'|[^\s]+)/gi;

/** A bearer token, in any case. */
const BEARER_TOKEN = /\bBearer\s+[^\s"'\`]+/gi;

/** A token of one of the known prefixes. */
const PREFIXED_TOKEN = /\b(?:sk[-_]|gh[pousr]_|xox[baprs]-|AIza)[A-Za-z0-9+/_=-]+/gi;

/** What replaces a secret: one character that reads as "the value was here". */
const REDACTED = "…";

/** What replaces a bearer token: the scheme word survives, the token does not. */
const REDACTED_BEARER = "Bearer …";

/** A URL cut to origin and path: no credentials, no fragment, no query. */
function urlWithoutSecrets(rawUrl: string): string {
  try {
    const href = new URL(rawUrl).href.replace(URL_CREDENTIALS, "$1");
    const withoutFragment = href.split("#")[0] ?? href;
    return withoutFragment.split("?")[0] ?? withoutFragment;
  } catch {
    return rawUrl;
  }
}

/** Everything the classifier may be shown, with each secret-shaped thing replaced. */
export function redactSlateAutoReviewInlineSecrets(text: string): string {
  return text
    .replace(URL_IN_TEXT, urlWithoutSecrets)
    .replace(KEYED_SECRET_VALUE, `$1${REDACTED}`)
    .replace(BEARER_TOKEN, REDACTED_BEARER)
    .replace(PREFIXED_TOKEN, REDACTED);
}
