/**
 * Escaping text that goes inside a prompt's XML-ish tags.
 *
 * Prompt sections are delimited by tags, so a value that contains a `<` or an `&` would either break
 * the section or — worse — look like a tag the model should obey. Escaping is applied to values, not
 * to the tags we write ourselves.
 */

export function escapePromptXmlText(value: string): string {
  return value.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;")
}
