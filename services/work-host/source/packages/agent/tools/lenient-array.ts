import { z } from "zod";
import { repairStringifiedArray } from "./lenient-array-repair.ts";

function preprocessLenientArray(
  value: unknown,
  options: { readonly field: string; readonly primitiveItems?: boolean },
): unknown {
  if (typeof value !== "string") return value;
  return repairStringifiedArray(value, options.field, options.primitiveItems === true) ?? value;
}

export function lenientArray<T extends z.ZodTypeAny>(
  schema: T,
  options: { readonly field: string; readonly primitiveItems?: boolean },
): z.ZodEffects<T, z.output<T>, unknown> {
  return z.preprocess((value) => preprocessLenientArray(value, options), schema);
}
