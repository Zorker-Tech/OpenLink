/**
 * Reading an ignore file the way the ignore service does.
 *
 * A rule file is lines of patterns: comments and blank lines say nothing, and leading whitespace is not part of a
 * pattern. The order of the patterns is kept, because an ignore file's meaning is its order.
 */
export function parseIgnoreRules(raw: string): string[] {
  return raw
    .split("\n")
    .map((line) => line.replace(/\r$/, "").trimStart())
    .filter((line) => line !== "" && !line.startsWith("#"));
}
