/**
 * Turning a name or a line into something a surface can show.
 *
 * A line is collapsed to one line and cut to the length it is allowed; a block keeps its own line breaks and is only
 * cut; a phrase is decapitalized so it can be dropped into the middle of a sentence; and a name becomes a slug, with a
 * fallback built from the time when the name has nothing a slug can hold.
 */

/** A run of any whitespace, which a one-line text collapses to a single space. */
const WHITESPACE_RUN = /\s+/g;

/** A run of characters a slug cannot hold, which becomes one hyphen. */
const SLUG_SEPARATORS = /[^a-z0-9]+/g;

/** The hyphens a slug may carry at its ends, which it drops. */
const EDGE_HYPHENS = /^-+|-+$/g;

/** The longest slug a name becomes. */
const SLUG_MAX_LENGTH = 48;

/** A text with its whitespace collapsed to single spaces and its ends trimmed. */
function oneLine(text: string): string {
  return text.replace(WHITESPACE_RUN, " ").trim();
}

/** A name reduced to the slug it can hold: lower case, hyphen-separated, cut to the slug length. */
function slugOf(name: string): string {
  return name.toLowerCase().replace(SLUG_SEPARATORS, "-").replace(EDGE_HYPHENS, "").slice(0, SLUG_MAX_LENGTH);
}

/** A line of text: one line, with its whitespace collapsed and its length cut where the surface wants. */
export function clampLine(text: string, limit: number): string {
  return oneLine(text).slice(0, limit);
}

/** A block of text with its ends trimmed and its length cut; its own line breaks stay. */
export function clampBlock(text: string, limit: number): string {
  return text.trim().slice(0, limit);
}

/** A phrase with its first character lower-cased, as it reads in the middle of a sentence. */
export function decapitalize(phrase: string): string {
  const first = phrase[0];
  if (first == null) return phrase;
  return first.toLowerCase() + phrase.slice(1);
}

/** A name as a slug, or a fallback built from the prefix and the moment when the name holds nothing a slug can. */
export function slugifyName(name: string, fallbackPrefix: string, fallbackAt = Date.now()): string {
  const slug = slugOf(name);
  return slug.length > 0 ? slug : `${fallbackPrefix}-${fallbackAt}`;
}
