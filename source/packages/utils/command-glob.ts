/** Quote literal pieces and give `*` its one supported wildcard meaning. */
function quotePatternText(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")
}

function commandPatternExpression(pattern: string): string {
  const pieces = pattern.trim().split("*").map(quotePatternText)
  return "^" + pieces.join(".*") + "$"
}

export function commandMatchesPattern(pattern: string, command: string): boolean {
  return new RegExp(commandPatternExpression(pattern)).test(command)
}
