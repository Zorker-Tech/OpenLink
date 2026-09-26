/**
 * Expanding the variables a plugin's configuration refers to.
 *
 * A plugin cannot know the values of the machine it is installed on, so its configuration spells them as variables with
 * an optional default. The expansion walks the whole configuration — strings, lists and nested objects alike — and a
 * variable that nothing defines and that has no default is left as it was written, since a value that was never
 * resolved is better seen than silently emptied.
 */
const ENV_VAR_PATTERN = /\$\{([^:}]+)(?::-([^}]*))?\}/g;
export type EnvLookup = (key: string) => string | undefined;
export function recordToCaseInsensitiveLookup(variables: Readonly<Record<string, string>>): EnvLookup { const lower = new Map(Object.entries(variables).map(([key, value]) => [key.toLowerCase(), value])); return (key) => variables[key] ?? lower.get(key.toLowerCase()); }
export function expandEnvVarsWithLookup<T>(value: T, envLookup: EnvLookup | Readonly<Record<string, string>>): T { return expandWithLookup(value, typeof envLookup === "function" ? envLookup : recordToCaseInsensitiveLookup(envLookup)); }
function expandWithLookup<T>(value: T, lookup: EnvLookup): T {
  if (typeof value === "string") return value.replace(ENV_VAR_PATTERN, (match, name: string, defaultValue: string | undefined) => lookup(name) ?? defaultValue ?? match) as T;
  if (Array.isArray(value)) return value.map((item) => expandWithLookup(item, lookup)) as T;
  if (value !== null && typeof value === "object") { const result: Record<string, unknown> = {}; for (const [key, nested] of Object.entries(value)) result[key] = expandWithLookup(nested, lookup); return result as T; }
  return value;
}
