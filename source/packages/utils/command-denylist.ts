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

const SEPARATOR_RUN = /[ \t\n\r\u00a0\u200b-\u200d\ufeff]+/g
const STAR_ONLY_RULE = /^\*+$/

export function normalizeAdminCommandDenylistText(value: string): string {
  return value.split(SEPARATOR_RUN).filter(part => part.length > 0).join(" ")
}

export function parseAdminCommandDenylistColonRule(
  rule: string,
): { executablePattern: string; argsPattern: string } | undefined {
  const colonOffset = rule.indexOf(":")
  if (colonOffset < 1) return undefined
  const executablePattern = rule.slice(0, colonOffset).trim()
  // A pattern with whitespace inside would never match a single executable name.
  if (/\s/u.test(executablePattern)) return undefined
  return { executablePattern, argsPattern: rule.slice(colonOffset + 1).trim() }
}

/** The reason a rule is unusable, or `null` when it is fine. */
export function getAdminCommandDenylistRuleError(rule: string): string | null {
  const candidate = normalizeAdminCommandDenylistText(rule).trim()
  if (candidate.length === 0) return "Rule cannot be empty"
  if (candidate.length > ADMIN_COMMAND_DENYLIST_MAX_RULE_LENGTH) {
    return `Rule cannot exceed ${ADMIN_COMMAND_DENYLIST_MAX_RULE_LENGTH} characters`
  }
  if (STAR_ONLY_RULE.test(candidate)) return "Rule cannot match every command; be more specific than wildcards alone"
  if (candidate.startsWith(":")) return "Colon rules need an executable before `:` (e.g. `aws:*s3 rm*`)"
  const colonRule = parseAdminCommandDenylistColonRule(candidate)
  if (
    colonRule !== undefined &&
    STAR_ONLY_RULE.test(colonRule.executablePattern) &&
    (colonRule.argsPattern.length === 0 || STAR_ONLY_RULE.test(colonRule.argsPattern))
  ) {
    return "Rule cannot match every command; narrow the executable or argument pattern"
  }
  return null
}
