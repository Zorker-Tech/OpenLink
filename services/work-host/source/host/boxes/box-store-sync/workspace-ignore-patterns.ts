import type { WorkspaceIgnoreRule, WorkspaceNegationReach } from "./workspace-ignore-contracts.ts";

/** Keep nonblank, noncomment lines and remove trailing whitespace without changing leading spaces. */
export function parseIgnorePatterns(text: string): string[] {
  const patterns: string[] = [];
  for (const line of text.split(/\r?\n/)) {
    const pattern = line.replace(/\s+$/, "");
    if (pattern !== "" && !pattern.startsWith("#")) patterns.push(pattern);
  }
  return patterns;
}

/** Convert one ignore-file entry into file/directory matchers and its negation reach. */
export function compileRule(rawPattern: string): WorkspaceIgnoreRule | null {
  const parsed = parseRuleText(rawPattern);
  if (parsed.pattern === "") return null;

  const body = globToRegexBody(parsed.pattern);
  const prefix = parsed.anchored ? "^" : "^(?:.*/)?";
  const fileSuffix = parsed.directoryOnly ? "/.*" : "(?:/.*)?";
  return {
    negated: parsed.negated,
    fileRe: new RegExp(`${prefix}${body}${fileSuffix}$`),
    dirRe: new RegExp(`${prefix}${body}(?:/.*)?$`),
    ...(parsed.negated ? { negationReach: computeNegationReach(parsed.pattern, parsed.anchored) } : {}),
  };
}

function parseRuleText(rawPattern: string): { pattern: string; negated: boolean; directoryOnly: boolean; anchored: boolean } {
  let pattern = rawPattern;
  const negated = pattern.startsWith("!");
  if (negated) pattern = pattern.slice(1);
  else if (pattern.startsWith("\\!") || pattern.startsWith("\\#")) pattern = pattern.slice(1);

  const directoryOnly = pattern.endsWith("/");
  if (directoryOnly) pattern = pattern.slice(0, -1);

  const anchored = pattern.startsWith("/") || pattern.includes("/");
  if (pattern.startsWith("/")) pattern = pattern.slice(1);
  return { pattern, negated, directoryOnly, anchored };
}

/** Find how far a negated path may reach before a wildcard makes its scope open-ended. */
export function computeNegationReach(pattern: string, anchored: boolean): WorkspaceNegationReach {
  if (!anchored) return { everywhere: true, literalPrefix: "" };

  const literalSegments: string[] = [];
  for (const segment of pattern.split("/")) {
    if (/[*?[]/.test(segment)) break;
    literalSegments.push(segment);
  }
  const literalPrefix = literalSegments.join("/");
  return literalPrefix.length === 0
    ? { everywhere: true, literalPrefix: "" }
    : { everywhere: false, literalPrefix };
}

/** Compile glob operators while keeping ordinary stars and question marks within a path segment. */
export function globToRegexBody(glob: string): string {
  let output = "";
  let index = 0;
  while (index < glob.length) {
    const character = glob[index];
    if (character === "*") {
      const end = runOfStarsEnd(glob, index);
      const doubleStar = end - index >= 2;
      const startsSegment = index === 0 || glob[index - 1] === "/";
      const endsAtDirectoryBoundary = glob[end] === "/";

      if (doubleStar && startsSegment && endsAtDirectoryBoundary) {
        output += "(?:.*/)?";
        index = end + 1;
      } else if (doubleStar && startsSegment) {
        output += ".*";
        index = end;
      } else {
        output += "[^/]*";
        index = end;
      }
      continue;
    }

    if (character === "?") {
      output += "[^/]";
      index += 1;
      continue;
    }

    if (character === "[") {
      const characterClass = readCharacterClass(glob, index);
      if (characterClass == null) {
        output += "\\[";
        index += 1;
      } else {
        output += characterClass.regex;
        index = characterClass.end;
      }
      continue;
    }

    output += escapeRegexCharacter(character ?? "");
    index += 1;
  }
  return output;
}

function runOfStarsEnd(pattern: string, start: number): number {
  let end = start;
  while (end < pattern.length && pattern[end] === "*") end += 1;
  return end;
}

function escapeRegexCharacter(character: string): string {
  return /[.*+?^${}()|[\]\\]/.test(character) ? `\\${character}` : character;
}

function readCharacterClass(glob: string, start: number): { regex: string; end: number } | null {
  let cursor = start + 1;
  const negatedClass = glob[cursor] === "!" || glob[cursor] === "^";
  if (negatedClass) cursor += 1;

  const contentStart = cursor;
  if (glob[cursor] === "]") cursor += 1;
  while (cursor < glob.length && glob[cursor] !== "]") cursor += 1;
  if (cursor >= glob.length) return null;

  const prefix = negatedClass ? "^" : "";
  return {
    regex: `[${prefix}${glob.slice(contentStart, cursor)}]`,
    end: cursor + 1,
  };
}
