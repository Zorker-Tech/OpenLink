import { IGNORE_NOTHING } from "./workspace-ignore-contracts.ts";
import type { WorkspaceIgnore, WorkspaceIgnoreRule, WorkspaceNegationReach } from "./workspace-ignore-contracts.ts";
import { compileRule } from "./workspace-ignore-patterns.ts";

/** Compile ordered ignore rules; a later matching negation makes the path visible again. */
export function compileWorkspaceIgnore(patterns: readonly string[]): WorkspaceIgnore {
  const rules = collectRules(patterns);
  if (rules.length === 0) return IGNORE_NOTHING;

  const ignoredDirectoryRules = rules.filter((rule) => !rule.negated);
  const negatedRules = rules.filter((rule) => rule.negated);
  return {
    ignores: (relPath) => isPathIgnored(rules, relPath),
    canPruneDir: (relDir) => canSkipDirectory(ignoredDirectoryRules, negatedRules, relDir),
  };
}

function collectRules(patterns: readonly string[]): WorkspaceIgnoreRule[] {
  const compiled: WorkspaceIgnoreRule[] = [];
  for (const pattern of patterns) {
    try {
      const rule = compileRule(pattern);
      if (rule != null) compiled.push(rule);
    } catch {
      if (pattern.startsWith("!")) return [];
    }
  }
  return compiled;
}

function isPathIgnored(rules: readonly WorkspaceIgnoreRule[], relPath: string): boolean {
  let ignored = false;
  for (const rule of rules) {
    if (rule.fileRe.test(relPath)) ignored = !rule.negated;
  }
  return ignored;
}

function canSkipDirectory(
  positiveRules: readonly WorkspaceIgnoreRule[],
  negativeRules: readonly WorkspaceIgnoreRule[],
  relDir: string,
): boolean {
  const isIgnoredByDirectoryRule = positiveRules.some((rule) => rule.dirRe.test(relDir));
  const mightContainIncludedPath = negativeRules.some((rule) => negationReaches(rule.negationReach, relDir));
  return isIgnoredByDirectoryRule && !mightContainIncludedPath;
}

/** Whether a negated pattern could name this directory or a path beneath it. */
export function negationReaches(reach: WorkspaceNegationReach | undefined, relDir: string): boolean {
  if (reach == null) return false;
  if (reach.everywhere) return true;

  const prefix = reach.literalPrefix;
  return prefix === relDir || prefix.startsWith(`${relDir}/`) || relDir.startsWith(`${prefix}/`);
}
