/**
 * Expanding the variables a plugin's configuration refers to.
 *
 * A plugin cannot know the values of the machine it is installed on, so its configuration spells them as variables with
 * an optional default. The expansion walks the whole configuration — strings, lists and nested objects alike — and a
 * variable that nothing defines and that has no default is left as it was written, since a value that was never
 * resolved is better seen than silently emptied.
 */

const ENV_VAR_PATTERN = /\$\{([^:}]+)(?::-([^}]*))?\}/g

export type EnvLookup = (key: string) => string | undefined

/** A lookup that tries the exact name first and a folded name second, so a variable is not case-sensitive. */
export function recordToCaseInsensitiveLookup(record: Readonly<Record<string, string>>): EnvLookup {
  const folded = new Map(Object.entries(record).map(([key, value]) => [key.toLowerCase(), value]))
  return (requested) => record[requested] ?? folded.get(requested.toLowerCase())
}

/** The value a variable resolves to, or the text as it was written when nothing resolves it. */
function resolveVariable(placeholder: string, variableName: string, fallback: string | undefined, resolve: EnvLookup): string {
  return resolve(variableName) ?? fallback ?? placeholder
}

/** A string with every variable it names resolved. */
function expandText(text: string, resolve: EnvLookup): string {
  return text.replace(ENV_VAR_PATTERN, (placeholder, variableName: string, fallback: string | undefined) =>
    resolveVariable(placeholder, variableName, fallback, resolve))
}

/** A list with every item expanded; the list itself is a new one. */
function expandList(items: readonly unknown[], resolve: EnvLookup): unknown[] {
  return items.map((item) => expandValue(item, resolve))
}

/** An object with its own values expanded; the keys are not variable names. */
function expandRecord(container: object, resolve: EnvLookup): Record<string, unknown> {
  const expanded: Record<string, unknown> = {}
  for (const [field, nested] of Object.entries(container)) expanded[field] = expandValue(nested, resolve)
  return expanded
}

/** A lookup from either form the exported reader accepts: a function, or a record of values. */
function lookupFrom(source: EnvLookup | Readonly<Record<string, string>>): EnvLookup {
  return typeof source === "function" ? source : recordToCaseInsensitiveLookup(source)
}

/** One value of the configuration, expanded the way its shape calls for. */
function expandValue<T>(candidate: T, resolve: EnvLookup): T {
  if (typeof candidate === "string") return expandText(candidate, resolve) as T
  if (Array.isArray(candidate)) return expandList(candidate, resolve) as T
  if (candidate !== null && typeof candidate === "object") return expandRecord(candidate, resolve) as T
  return candidate
}

export function expandEnvVarsWithLookup<T>(configuration: T, lookupSource: EnvLookup | Readonly<Record<string, string>>): T {
  return expandValue(configuration, lookupFrom(lookupSource))
}
