/**
 * Provider model identifiers are opaque catalog values, not paths or URLs.
 * They are namespaced (`openrouter/anthropic/claude-sonnet`), tagged
 * (`model:free`, `model:latest`), scoped (`@cf/meta/llama`) and sometimes
 * prefixed with an alias marker (`~anthropic/claude-sonnet-latest`).
 *
 * The validator keeps the character set bounded for storage and transport
 * while accepting every punctuation style used by provider catalogs. It
 * rejects whitespace and control characters.
 */
export const MODEL_ID_PATTERN = /^[A-Za-z0-9@~][A-Za-z0-9._:/@~+-]{0,255}$/

export function isValidModelId(value: string): boolean {
  return MODEL_ID_PATTERN.test(value)
}
