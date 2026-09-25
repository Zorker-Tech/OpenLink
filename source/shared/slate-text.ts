/**
 * Turning a name or a line into something a surface can show.
 *
 * A line is collapsed to one line and cut to the length it is allowed; a block keeps its own line breaks and is only
 * cut; a phrase is decapitalized so it can be dropped into the middle of a sentence; and a name becomes a slug, with a
 * fallback built from the time when the name has nothing a slug can hold.
 */
export function clampLine(raw: string, maxLength: number): string { return raw.replace(/\s+/g, " ").trim().slice(0, maxLength); }
export function clampBlock(raw: string, maxLength: number): string { return raw.trim().slice(0, maxLength); }
export function decapitalize(phrase: string): string { const first = phrase[0]; return first == null ? phrase : first.toLowerCase() + phrase.slice(1); }
export function slugifyName(name: string, fallbackPrefix: string, now = Date.now()): string { const slug = name.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 48); return slug.length > 0 ? slug : `${fallbackPrefix}-${now}`; }
