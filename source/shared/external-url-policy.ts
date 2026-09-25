/**
 * Which links the platform will open in the user's browser.
 *
 * Only the protocols a browser can be handed safely are allowed — the web, mail, telephone, and the note-taking scheme
 * the platform integrates with — so a document cannot make the platform open something else on the user's machine.
 */
export const ALLOWED_EXTERNAL_PROTOCOLS = new Set([
  "http:",
  "https:",
  "mailto:",
  "obsidian:",
  "tel:",
]);

function externalUrl(value: unknown): URL | null {
  if (typeof value !== "string" || value.length === 0) return null;
  try {
    return new URL(value);
  } catch {
    return null;
  }
}

export function parseAllowedExternalUrl(value: unknown): string | null {
  const url = externalUrl(value);
  if (url == null || !ALLOWED_EXTERNAL_PROTOCOLS.has(url.protocol)) return null;
  return url.href;
}

export function isHttpExternalUrl(value: unknown): boolean {
  const url = externalUrl(value);
  return url?.protocol === "http:" || url?.protocol === "https:";
}
