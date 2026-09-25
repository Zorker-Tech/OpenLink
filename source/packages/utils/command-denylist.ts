/**
 * Rules that keep an agent away from commands a team has forbidden.
 *
 * A rule is either a command name or `executable:arguments`, each side optionally holding `*`
 * wildcards. Rules are written by people, so they are normalized before they are judged (separators
 * collapsed, invisible spaces removed) and refused with a reason when they are too broad to mean
 * anything — a rule that matches every command is worse than no rule, because it looks like
 * protection.
 */

export const ADMIN_COMMAND_DENYLIST_MAX_RULE_LENGTH = 512

/** Separators that look like spaces but are not the ASCII one, plus the zero-width characters. */
const isSeparator = (character: string): boolean =>
  character === " " || character === "\t" || character === "\n" || character === "\r" ||
  character === "\u00a0" || character === "\u200b" || character === "\u200c" ||
  character === "\u200d" || character === "\ufeff"

export function normalizeAdminCommandDenylistText(value: string): string {
  let result = ""
  let pendingSeparator = false
  for (const character of value) {
    if (isSeparator(character)) {
      pendingSeparator = true
      continue
    }
    if (pendingSeparator && result.length > 0) result += " "
    pendingSeparator = false
    result += character
  }
  return result
}

const isOnlyWildcards = (value: string): boolean =>
  value.length > 0 && [...value].every(character => character === "*")

export function parseAdminCommandDenylistColonRule(
  rule: string,
): { executablePattern: string; argsPattern: string } | undefined {
  const index = rule.indexOf(":")
  if (index <= 0) return undefined
  const executablePattern = rule.slice(0, index).trim()
  // A pattern with whitespace inside would never match a single executable name.
  if ([...executablePattern].some(character => character.trim().length === 0)) return undefined
  return { executablePattern, argsPattern: rule.slice(index + 1).trim() }
}

/** The reason a rule is unusable, or `null` when it is fine. */
export function getAdminCommandDenylistRuleError(rule: string): string | null {
  const trimmed = normalizeAdminCommandDenylistText(rule).trim()
  if (trimmed.length === 0) return "Rule cannot be empty"
  if (trimmed.length > ADMIN_COMMAND_DENYLIST_MAX_RULE_LENGTH) {
    return `Rule cannot exceed ${ADMIN_COMMAND_DENYLIST_MAX_RULE_LENGTH} characters`
  }
  if (isOnlyWildcards(trimmed)) return "Rule cannot match every command; be more specific than wildcards alone"
  if (trimmed.startsWith(":")) return "Colon rules need an executable before `:` (e.g. `aws:*s3 rm*`)"
  const colonRule = parseAdminCommandDenylistColonRule(trimmed)
  if (
    colonRule !== undefined &&
    isOnlyWildcards(colonRule.executablePattern) &&
    (colonRule.argsPattern.length === 0 || isOnlyWildcards(colonRule.argsPattern))
  ) {
    return "Rule cannot match every command; narrow the executable or argument pattern"
  }
  return null
}
