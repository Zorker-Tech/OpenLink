/**
 * Matching a command against a pattern that may hold `*`.
 *
 * The pattern is escaped first and only the wildcards are translated, so a pattern containing regex
 * metacharacters matches them literally — which is what a person writing `git status` means. A
 * pattern that will not compile is compared as a plain string rather than throwing at the caller.
 */

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")
}

export function matchesCommandGlob(pattern: string, value: string): boolean {
  const trimmedPattern = pattern.trim()
  const regexSource = `^${escapeRegExp(trimmedPattern).replace(/\\\*/g, ".*")}$`
  try {
    return new RegExp(regexSource).test(value)
  } catch {
    return trimmedPattern === value
  }
}
