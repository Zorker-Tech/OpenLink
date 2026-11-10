/** Slate's wordmark and its compact form for protocol fields that accept one token. */
const wordmark = "Slate"

export const SLATE_BRAND = Object.freeze({
  displayName: wordmark,
  httpToken: wordmark.replaceAll(/\s+/g, ""),
})
