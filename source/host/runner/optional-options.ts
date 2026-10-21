/**
 * An option object without the keys the caller left out.
 *
 * The platform's option types are exact (`exactOptionalPropertyTypes`): `{ modelId: undefined }` is not the same as
 * `{}`, and is rejected. Threading optional values through would otherwise mean writing
 * `...(value === undefined ? {} : { value })` at every single field, which buries the decisions the code actually makes
 * among the spreads. This drops the absent keys once, here.
 */
export function presentOptions<T extends object>(values: T): { [K in keyof T]?: Exclude<T[K], undefined> } {
  const present: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(values)) {
    if (value !== undefined) present[key] = value;
  }
  return present as { [K in keyof T]?: Exclude<T[K], undefined> };
}

/** An entry built from a value, or nothing at all when the caller did not give one. */
export function maybeEntry<T, R extends object>(value: T | undefined, build: (value: T) => R): R | Record<string, never> {
  return value === undefined ? {} : build(value);
}
