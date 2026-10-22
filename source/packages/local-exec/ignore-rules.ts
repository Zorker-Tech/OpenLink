/**
 * Reading an ignore file the way the ignore service does.
 *
 * A rule file is lines of patterns: comments and blank lines say nothing, and leading whitespace is not part of a
 * pattern. The order of the patterns is kept, because an ignore file's meaning is its order.
 */

/** The line ending a rule file may carry on a platform that writes the other separator. */
const CARRIAGE_RETURN_AT_END = /\r$/;

/** A rule line as it is read: without its line ending and without its leading whitespace. */
function ruleTextOf(line: string): string {
  return line.replace(CARRIAGE_RETURN_AT_END, "").trimStart();
}

/** Whether a rule line says nothing: it is blank, or it is a comment. */
function saysNothing(ruleText: string): boolean {
  return ruleText === "" || ruleText.startsWith("#");
}

export function parseIgnoreRules(raw: string): string[] {
  const rules: string[] = [];
  for (const line of raw.split("\n")) {
    const ruleText = ruleTextOf(line);
    if (!saysNothing(ruleText)) rules.push(ruleText);
  }
  return rules;
}
