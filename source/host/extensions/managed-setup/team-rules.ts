import { createTeamRulesResolverFromLoad, type RulesAnswer, type TeamRulesResolver } from "../../../shared/team-rules.ts";

export const TEAM_RULES_REQUEST_TIMEOUT_MS = 10_000;

export const TeamRuleAgentType = {
  UNSPECIFIED: 0,
  ALL: 1,
  SLATE: 2,
  OTHER: 3,
} as const;

export interface TeamRule {
  readonly agentType: number;
  readonly name: string;
  readonly content: string;
  readonly globs?: readonly string[] | null;
  readonly isRequired: boolean;
}

export interface TeamRuleEntry {
  readonly fullPath: string;
  readonly content: string;
  readonly type: { readonly kind: "global" } | { readonly kind: "fileGlobbed"; readonly globs: string[] };
  readonly source: "team";
  readonly isRequired: boolean;
}

export interface TeamRulesClient {
  getTeams(
    request: { readonly activeOnly: true },
    options: { readonly timeoutMs: number },
  ): Promise<{ readonly teams: readonly { readonly id: number; readonly isDirectMember: boolean }[] }>;
  getTeamRules(
    request: { readonly activeOnly: true; readonly teamId: number },
    options: { readonly timeoutMs: number },
  ): Promise<{ readonly rules: readonly TeamRule[] }>;
}

export interface TeamRulesDiagnostic {
  readonly extension: "managed_setup";
  readonly kind: string;
  readonly errorClass: string;
}

export function appliesToSlate(rule: Pick<TeamRule, "agentType">): boolean {
  return rule.agentType === TeamRuleAgentType.SLATE || rule.agentType === TeamRuleAgentType.ALL;
}

export function directMemberTeamIds(response: {
  readonly teams: readonly { readonly id: number; readonly isDirectMember: boolean }[];
}): number[] {
  return response.teams
    .filter(team => team.id > 0 && team.isDirectMember)
    .map(team => team.id);
}

export function teamRuleToEntry(rule: TeamRule): TeamRuleEntry {
  const globs = rule.globs ?? [];
  return {
    fullPath: rule.name,
    content: rule.content,
    type: globs.length === 0 ? { kind: "global" } : { kind: "fileGlobbed", globs: [...globs] },
    source: "team",
    isRequired: rule.isRequired,
  };
}

export function mergeRulesByFullPath<T extends { readonly fullPath: string }>(batches: readonly (readonly T[])[]): T[] {
  const visitedPaths = new Set<string>();
  const result: T[] = [];
  for (const batch of batches) {
    for (const rule of batch) {
      if (visitedPaths.has(rule.fullPath)) continue;
      visitedPaths.add(rule.fullPath);
      result.push(rule);
    }
  }
  return result;
}

export function createSlateTeamRulesResolver(options: {
  readonly client: TeamRulesClient;
  readonly report?: (event: TeamRulesDiagnostic) => void;
}): TeamRulesResolver<TeamRuleEntry> {
  const report = options.report ?? (() => {});

  const getTeamIds = async (): Promise<number[] | undefined> => {
    try {
      const response = await options.client.getTeams(
        { activeOnly: true },
        { timeoutMs: TEAM_RULES_REQUEST_TIMEOUT_MS },
      );
      return directMemberTeamIds(response);
    } catch (error) {
      report({
        extension: "managed_setup",
        kind: "team_rules_membership",
        errorClass: errorClassName(error),
      });
      return undefined;
    }
  };

  const readRulesForTeams = async (teamIds: readonly number[]): Promise<RulesAnswer<TeamRuleEntry>> => {
    try {
      const teamBatches = await Promise.all(teamIds.map(async teamId => {
        const response = await options.client.getTeamRules(
          { activeOnly: true, teamId },
          { timeoutMs: TEAM_RULES_REQUEST_TIMEOUT_MS },
        );
        return response.rules.filter(appliesToSlate).map(teamRuleToEntry);
      }));
      return { outcome: "rules", rules: mergeRulesByFullPath(teamBatches) };
    } catch (error) {
      report({
        extension: "managed_setup",
        kind: "team_rules_fetch",
        errorClass: errorClassName(error),
      });
      return { outcome: "incomplete" };
    }
  };

  const load = async (): Promise<RulesAnswer<TeamRuleEntry>> => {
    const teamIds = await getTeamIds();
    if (teamIds === undefined) return { outcome: "incomplete" };
    if (teamIds.length === 0) return { outcome: "no_team" };
    return await readRulesForTeams(teamIds);
  };

  return createTeamRulesResolverFromLoad({
    load,
    reportLoadFailure: error => report({
      extension: "managed_setup",
      kind: "team_rules_retry",
      errorClass: errorClassName(error),
    }),
  });
}

function errorClassName(error: unknown): string {
  if (error instanceof Error) return error.name || "Error";
  return typeof error;
}
