import { jsonTokens, namesAKeyTwice } from "./mcp/argument-repair.ts";

export interface LeadingArrayCandidate {
  readonly value: unknown[];
  readonly rest: string;
}

export function parseWholeJsonArray(text: string): unknown[] | undefined {
  if (namesAKeyTwice(text)) return undefined;
  try {
    const decoded: unknown = JSON.parse(text);
    return Array.isArray(decoded) ? decoded : undefined;
  } catch {
    return undefined;
  }
}

export function parseLeadingJsonArray(text: string): LeadingArrayCandidate | undefined {
  const bracket = text.indexOf("[");
  if (bracket < 0) return undefined;

  let nesting = 0;
  for (const token of jsonTokens(text, bracket)) {
    if (token.kind !== "punctuation") continue;
    if (token.char === "[" || token.char === "{") {
      nesting += 1;
      continue;
    }
    if ((token.char === "]" || token.char === "}") && --nesting === 0) {
      const value = parseWholeJsonArray(text.slice(bracket, token.index + 1));
      return value === undefined ? undefined : { value, rest: text.slice(token.index + 1) };
    }
  }
  return undefined;
}
