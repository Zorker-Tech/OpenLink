export function readAllowlistedQuery(
  url: URL,
  allowlist: Readonly<Record<string, readonly string[]>>,
): Record<string, string> | null {
  const values: Record<string, string> = {};
  for (const [key, value] of url.searchParams) {
    const permittedValues = allowlist[key];
    if (!Object.hasOwn(allowlist, key) || Object.hasOwn(values, key) || !permittedValues?.includes(value)) return null;
    values[key] = value;
  }

  for (const requiredKey of Object.keys(allowlist)) {
    if (!Object.hasOwn(values, requiredKey)) return null;
  }
  return values;
}
