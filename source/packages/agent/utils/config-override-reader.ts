import { createKey, type Context } from "../../context/context.ts";

export const slateConfigOverridesKey = createKey<Record<string, unknown>>(
  Symbol("slateConfigOverrides"),
  {},
);

export function readContextOverride<Value>(
  key: string,
  fallback: Value,
): (context: Context) => Value {
  return (context) => {
    const candidate = context.get(slateConfigOverridesKey)[key] as Value | null | undefined;
    return candidate ?? fallback;
  };
}
