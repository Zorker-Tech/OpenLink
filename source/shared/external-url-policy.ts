/**
 * Which links the platform will open in the user's browser.
 *
 * Only the protocols a browser can be handed safely are allowed — the web, mail, telephone, and the note-taking scheme
 * the platform integrates with — so a document cannot make the platform open something else on the user's machine.
 */

/** The protocols a link may name if the platform is to open it at all. */
export const OPENABLE_PROTOCOLS = new Set(["http:", "https:", "mailto:", "obsidian:", "tel:"]);

/** The two a link must name to be a web page, which is what most callers mean by "external". */
const WEB_PROTOCOLS: ReadonlySet<string> = new Set(["http:", "https:"]);

/** A link read from whatever a caller was given, or nothing when it is not a link. */
function externalUrl(value: unknown): URL | null {
  if (typeof value !== "string" || value.length === 0) return null;
  try {
    return new URL(value);
  } catch {
    return null;
  }
}

/**
 * The link as the address a browser is given, or nothing when the platform will not open it.
 *
 * What comes back is the parsed address rather than the text that was handed in, so a caller opens exactly what was
 * checked.
 */
export function openableExternalUrl(value: unknown): string | null {
  const url = externalUrl(value);
  if (url == null || !OPENABLE_PROTOCOLS.has(url.protocol)) return null;
  return url.href;
}

/** Whether this link is a web page, which is the only thing a browser is handed without asking. */
export function isWebUrl(value: unknown): boolean {
  const url = externalUrl(value);
  return url !== null && WEB_PROTOCOLS.has(url.protocol);
}
