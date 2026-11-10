import type { BoxEnvironmentUpdate } from "./box-env.ts"

/** Validate a runtime value before it becomes an environment change for a box. */
export function decodeBoxEnvironmentUpdate(value: unknown): BoxEnvironmentUpdate {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new TypeError("box environment update must be an object")
  }

  const environment = Reflect.get(value, "env")
  const replace = Reflect.get(value, "replace")
  if (typeof environment !== "object" || environment === null || Array.isArray(environment) || typeof replace !== "boolean") {
    throw new TypeError("box environment update has an invalid shape")
  }

  const entries: Record<string, string> = {}
  for (const [name, entry] of Object.entries(environment)) {
    if (typeof entry !== "string") throw new TypeError("box environment value for " + name + " must be a string")
    entries[name] = entry
  }
  return { env: entries, replace }
}
