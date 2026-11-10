/**
 * Escaping text that goes inside a prompt's XML-ish tags.
 *
 * Prompt sections are delimited by tags, so a value that contains a `<` or an `&` would either break
 * the section or — worse — look like a tag the model should obey. Escaping is applied to values, not
 * to the tags we write ourselves.
 */

/** The escapes, in the order they are applied: the ampersand first, so the entities it writes are not escaped again. */
const PROMPT_XML_ESCAPES: ReadonlyArray<readonly [RegExp, string]> = [
  [/&/g, "&amp;"],
  [/</g, "&lt;"],
  [/>/g, "&gt;"],
];

export function escapePromptXmlText(value: string): string {
  return PROMPT_XML_ESCAPES.reduce((text, [pattern, entity]) => text.replace(pattern, entity), value);
}
