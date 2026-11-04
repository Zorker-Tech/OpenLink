/**
 * The commands an administrator has forbidden.
 *
 * A rule is matched against a command that has been canonicalized first: escape sequences are decoded, quoting and
 * whitespace are normalized, and the ways a shell can spell the same command are reduced to one form, so a rule cannot
 * be slipped past by writing the command differently. A rule may also be a pattern, which is matched against the
 * command as it was canonicalized. A command that cannot be analyzed at all is treated as forbidden, since a rule that
 * cannot be checked is not a rule that passed.
 */
import {
  getAdminCommandDenylistRuleError,
  normalizeAdminCommandDenylistText,
  parseAdminCommandDenylistColonRule,
} from "../../utils/command-denylist.ts";
import { commandMatchesPattern } from "../../utils/command-glob.ts";

interface CommandLine {
  readonly fullText: string;
}

export interface AdminCommandParsingResult {
  readonly parsingFailed: boolean;
  readonly executableCommands: readonly CommandLine[];
}

export interface AdminCommandDenylistMatchInput {
  readonly command: string;
  readonly parsingResult: AdminCommandParsingResult;
  readonly blockedCommands: readonly string[];
}

const UNANALYZABLE_REASON =
  "Denied: this command could not be conclusively analyzed against your team's administrator command denylist, so it was blocked (fail-closed) and was not executed. It cannot be approved from this conversation; only a user can run it manually outside the agent. You may continue working on the task.";

function matchFormsOf({
  command,
  parsingResult,
}: Pick<AdminCommandDenylistMatchInput, "command" | "parsingResult">): string[] {
  return [
    ...new Set([
      command,
      ...parsingResult.executableCommands.map((candidate) => candidate.fullText),
    ]),
  ];
}

const ANSI_ESCAPES: Record<string, string> = {
  a: "\x07",
  b: "\b",
  e: "\x1b",
  E: "\x1b",
  f: "\f",
  n: "\n",
  r: "\r",
  t: "\t",
  v: "\v",
  "\\": "\\",
  "'": "'",
  '"': '"',
  "?": "?",
};

function canonicalCommandText(command: string): string {
  let canonicalText = "";
  let quoteMode: "plain" | "single" | "double" | "ansi" = "plain";
  let cursor = 0;
  while (cursor < command.length) {
    const currentCharacter = command[cursor]!;
    if (quoteMode === "plain") {
      if (currentCharacter === "$" && command[cursor + 1] === "'") {
        quoteMode = "ansi";
        cursor += 2;
      } else if (currentCharacter === "$" && command[cursor + 1] === '"') {
        quoteMode = "double";
        cursor += 2;
      } else if (currentCharacter === "'") {
        quoteMode = "single";
        cursor += 1;
      } else if (currentCharacter === '"') {
        quoteMode = "double";
        cursor += 1;
      } else if (currentCharacter === "\\" && cursor + 1 < command.length) {
        if (command[cursor + 1] !== "\n") {
          canonicalText += command[cursor + 1];
        }
        cursor += 2;
      } else {
        canonicalText += currentCharacter;
        cursor += 1;
      }
      continue;
    }
    if (quoteMode === "single") {
      if (currentCharacter === "'") quoteMode = "plain";
      else canonicalText += currentCharacter;
      cursor += 1;
      continue;
    }
    if (quoteMode === "double") {
      if (currentCharacter === '"') {
        quoteMode = "plain";
        cursor += 1;
        continue;
      }
      if (currentCharacter === "\\" && cursor + 1 < command.length) {
        const nextCharacter = command[cursor + 1]!;
        if (["$", "`", '"', "\\", "\n"].includes(nextCharacter)) {
          if (nextCharacter !== "\n") canonicalText += nextCharacter;
          cursor += 2;
          continue;
        }
      }
      canonicalText += currentCharacter;
      cursor += 1;
      continue;
    }
    if (currentCharacter === "'") {
      quoteMode = "plain";
      cursor += 1;
      continue;
    }
    if (currentCharacter !== "\\" || cursor + 1 >= command.length) {
      canonicalText += currentCharacter;
      cursor += 1;
      continue;
    }
    const nextCharacter = command[cursor + 1]!;
    const mappedEscape = ANSI_ESCAPES[nextCharacter];
    if (mappedEscape !== undefined) {
      canonicalText += mappedEscape;
      cursor += 2;
      continue;
    }
    const digits = nextCharacter === "x"
      ? command.slice(cursor + 2).match(/^[0-9a-fA-F]{1,2}/)?.[0]
      : nextCharacter === "u"
        ? command.slice(cursor + 2).match(/^[0-9a-fA-F]{1,4}/)?.[0]
        : nextCharacter === "U"
          ? command.slice(cursor + 2).match(/^[0-9a-fA-F]{1,8}/)?.[0]
          : command.slice(cursor + 1).match(/^[0-7]{1,3}/)?.[0];
    const isUnicode = nextCharacter === "u" || nextCharacter === "U";
    const numberBase = nextCharacter === "x" || isUnicode ? 16 : 8;
    if (digits !== undefined) {
      const codePoint = Number.parseInt(digits, numberBase);
      if (!isUnicode || codePoint <= 0x10ffff) {
        canonicalText += isUnicode ? String.fromCodePoint(codePoint) : String.fromCharCode(codePoint);
        cursor += digits.length + (numberBase === 16 ? 2 : 1);
        continue;
      }
    }
    canonicalText += nextCharacter;
    cursor += 2;
  }
  return normalizeAdminCommandDenylistText(canonicalText);
}

function ruleMatchesCommand(rule: string, command: string): boolean {
  const ruleText = normalizeAdminCommandDenylistText(rule).trim();
  if (ruleText.length === 0) return false;
  if (getAdminCommandDenylistRuleError(ruleText) !== null) return true;
  return [
    command.trim(),
    normalizeAdminCommandDenylistText(command).trim(),
    canonicalCommandText(command).trim(),
  ].some((commandForm) => singleRuleMatches(ruleText, commandForm));
}

function singleRuleMatches(ruleText: string, commandText: string): boolean {
  const colonSpec = parseAdminCommandDenylistColonRule(ruleText);
  if (colonSpec !== undefined) {
    const firstSpace = commandText.indexOf(" ");
    const program = firstSpace === -1 ? commandText : commandText.slice(0, firstSpace);
    const argumentsText = firstSpace === -1 ? "" : commandText.slice(firstSpace + 1).trim();
    if (commandMatchesPattern(colonSpec.executablePattern, program) && commandMatchesPattern(colonSpec.argsPattern, argumentsText)) return true;
  }
  if (ruleText.includes("*")) return commandMatchesPattern(ruleText, commandText);
  return commandText === ruleText || commandText.startsWith(`${ruleText} `);
}

function firstMatchingRule({
  matchForms,
  blockedCommands,
}: { readonly matchForms: readonly string[]; readonly blockedCommands: readonly string[] }): string | undefined {
  const rules = blockedCommands.map((entry) => entry.trim()).filter((entry) => entry.length > 0);
  if (rules.length === 0) return undefined;
  const forms = matchForms.map((form) => form.trim()).filter((form) => form.length > 0);
  const effectiveForms = forms.length > 0 ? forms : [""];
  for (const rule of rules) {
    if (effectiveForms.some((commandForm) => ruleMatchesCommand(rule, commandForm))) return rule;
  }
  return undefined;
}

export function formatAdminCommandDenylistBlockReason(pattern: string): string {
  return `Denied: this command was blocked by administrator policy (denylist rule: ${pattern}) and was not executed. It cannot be approved from this conversation; only a user can run it manually outside the agent. You may continue working on the task.`;
}

export function getModelShellAdminCommandDenylistBlockReason({
  command,
  parsingResult,
  blockedCommands,
}: AdminCommandDenylistMatchInput): string | undefined {
  if (blockedCommands.length === 0) return undefined;
  if (parsingResult.parsingFailed || parsingResult.executableCommands.length === 0) return UNANALYZABLE_REASON;
  const matchedPattern = firstMatchingRule({
    matchForms: matchFormsOf({ command, parsingResult }),
    blockedCommands,
  });
  return matchedPattern === undefined ? undefined : formatAdminCommandDenylistBlockReason(matchedPattern);
}
