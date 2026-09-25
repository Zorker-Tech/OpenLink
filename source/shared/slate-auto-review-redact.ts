/**
 * Taking secrets out of what the auto-review classifier is shown.
 *
 * A command or a patch may carry a credential, and the classifier is shown what it needs to judge without being shown
 * the credential itself: a URL is cut down to its origin and path, a value that looks like a token is replaced, and a
 * key whose name says it holds a secret has its value replaced however it was spelled.
 */
export const SLATE_AUTO_REVIEW_SECRET_VALUE_PATTERN =
  /^(?:bearer\s+|sk[-_]|gh[pousr]_|xox[baprs]-|AIza)[^\s]*$/i;
export const SLATE_AUTO_REVIEW_SECRET_KEY_PATTERN =
  /(?:auth|credential|key|password|secret|signature|token)/i;

export function redactSlateAutoReviewInlineSecrets(value: string): string {
  return value
    .replace(/https?:\/\/[^\s"'`]+/gi, (rawUrl) => {
      try {
        const href = new URL(rawUrl).href.replace(/^(https?:\/\/)[^/?#]*@/i, "$1");
        const withoutHash = href.split("#")[0] ?? href;
        return withoutHash.split("?")[0] ?? withoutHash;
      } catch {
        return rawUrl;
      }
    })
    .replace(
      /((?:--)?(?:api[_-]?key|authorization|credential|password|secret|signature|token)\s*(?:=|:|\s)\s*)(?:"[^"]*"|'[^']*'|[^\s]+)/gi,
      "$1…",
    )
    .replace(/\bBearer\s+[^\s"'`]+/gi, "Bearer …")
    .replace(/\b(?:sk[-_]|gh[pousr]_|xox[baprs]-|AIza)[A-Za-z0-9+/_=-]+/gi, "…");
}
