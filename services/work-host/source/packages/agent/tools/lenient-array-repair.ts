import { leakedParameter } from "./mcp/argument-repair.ts";
import { parseLeadingJsonArray, parseWholeJsonArray } from "./lenient-array-json.ts";

function appearsToContainMultipleItems(value: string): boolean {
  return /,\s*\S/.test(value) || /\n\s*\S/.test(value);
}

type LeakedParameterResult =
  | { readonly found: false }
  | { readonly found: true; readonly value: unknown[] | undefined };

function repairLeakedParameter(value: string, field: string): LeakedParameterResult {
  const tags = [...value.matchAll(leakedParameter)];
  if (tags.length === 0) return { found: false };
  const tagNames = tags.map((tag) => tag[1]);
  const localTags = tags.filter((tag) => tag[1] === field);
  if (localTags.length !== 1 || !tagNames.every((name) => name === field)) return { found: true, value: undefined };
  return { found: true, value: parseWholeJsonArray((localTags[0]?.[2] ?? "").trim()) };
}

export function repairStringifiedArray(value: string, field: string, primitiveItems: boolean): unknown[] | undefined {
  const trimmed = value.trim();
  if (trimmed.length === 0) return undefined;

  const exactArray = parseWholeJsonArray(trimmed);
  if (exactArray !== undefined) return exactArray;

  const fromParameter = repairLeakedParameter(trimmed, field);
  if (fromParameter.found) return fromParameter.value;

  if (primitiveItems && !/^[[{]/.test(trimmed)) {
    if (appearsToContainMultipleItems(trimmed)) return undefined;
    if (parseWholeJsonArray(`[${trimmed}]`) === undefined) return [value];
  }

  if (!trimmed.startsWith("[")) return undefined;
  const leading = parseLeadingJsonArray(trimmed);
  if (leading === undefined || !/^[\s,\]}]*$/.test(leading.rest)) return undefined;
  return leading.value;
}
