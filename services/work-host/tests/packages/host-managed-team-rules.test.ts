import assert from "node:assert/strict";
import { describe, it } from "node:test";

import {
  appliesToSlate,
  createSlateTeamRulesResolver,
  directMemberTeamIds,
  mergeRulesByFullPath,
  TEAM_RULES_REQUEST_TIMEOUT_MS,
  TeamRuleAgentType,
  teamRuleToEntry,
  type TeamRule,
  type TeamRulesClient,
} from "../../source/host/extensions/managed-setup/team-rules.ts";

function clientWorld(options: {
  readonly teams?: readonly { id: number; isDirectMember: boolean }[];
  readonly membershipFailure?: unknown;
  readonly rules?: ReadonlyMap<number, readonly TeamRule[]>;
  readonly ruleFailures?: ReadonlyMap<number, unknown>;
} = {}) {
  const calls: Array<{ readonly kind: "teams"; readonly request: unknown; readonly timeoutMs: number } | { readonly kind: "rules"; readonly teamId: number; readonly timeoutMs: number }> = [];
  const reports: Array<{ extension: "managed_setup"; kind: string; errorClass: string }> = [];
  const client: TeamRulesClient = {
    async getTeams(request, { timeoutMs }) {
      calls.push({ kind: "teams", request, timeoutMs });
      if (options.membershipFailure !== undefined) throw options.membershipFailure;
      return { teams: options.teams ?? [] };
    },
    async getTeamRules(request, { timeoutMs }) {
      calls.push({ kind: "rules", teamId: request.teamId, timeoutMs });
      if (options.ruleFailures?.has(request.teamId)) throw options.ruleFailures.get(request.teamId);
      return { rules: options.rules?.get(request.teamId) ?? [] };
    },
  };
  const resolver = createSlateTeamRulesResolver({ client, report: event => reports.push(event) });
  return { calls, reports, resolver };
}

describe("managed team rule membership", () => {
  it("reads only positive direct-member teams with the fixed active-only request", async () => {
    const world = clientWorld({
      teams: [
        { id: 0, isDirectMember: true },
        { id: 8, isDirectMember: false },
        { id: 4, isDirectMember: true },
      ],
    });

    assert.deepEqual(directMemberTeamIds({ teams: [{ id: -2, isDirectMember: true }, { id: 5, isDirectMember: true }, { id: 6, isDirectMember: false }] }), [5]);
    assert.equal(TEAM_RULES_REQUEST_TIMEOUT_MS, 10_000);
    assert.deepEqual(await world.resolver.resolveRules(), []);
    assert.deepEqual(world.calls, [
      { kind: "teams", request: { activeOnly: true }, timeoutMs: 10_000 },
      { kind: "rules", teamId: 4, timeoutMs: 10_000 },
    ]);
  });

  it("returns an empty answer when no direct team is available", async () => {
    const world = clientWorld({ teams: [{ id: 9, isDirectMember: false }] });
    assert.deepEqual(await world.resolver.resolveRules(), []);
    assert.deepEqual(world.calls, [{ kind: "teams", request: { activeOnly: true }, timeoutMs: 10_000 }]);
  });

  it("leaves the answer unknown and reports a membership failure", async () => {
    const world = clientWorld({ membershipFailure: new TypeError("offline") });
    assert.equal(await world.resolver.resolveRules(), undefined);
    assert.deepEqual(world.reports, [{ extension: "managed_setup", kind: "team_rules_membership", errorClass: "TypeError" }]);
  });
});

describe("managed team rule projection", () => {
  it("keeps Slate and shared rules, copies globs, and lets the first full path win", async () => {
    const globs = ["src/**/*.ts"];
    const world = clientWorld({
      teams: [{ id: 2, isDirectMember: true }, { id: 3, isDirectMember: true }],
      rules: new Map([
        [2, [
          { agentType: TeamRuleAgentType.ALL, name: "/global", content: "first", isRequired: true },
          { agentType: TeamRuleAgentType.SLATE, name: "/file", content: "pattern", globs, isRequired: false },
          { agentType: TeamRuleAgentType.OTHER, name: "/other", content: "skip", isRequired: false },
          { agentType: TeamRuleAgentType.UNSPECIFIED, name: "/unspecified", content: "skip", isRequired: false },
        ]],
        [3, [
          { agentType: TeamRuleAgentType.ALL, name: "/global", content: "second", isRequired: false },
          { agentType: TeamRuleAgentType.SLATE, name: "/new", content: "global", globs: [], isRequired: false },
        ]],
      ]),
    });

    assert.equal(appliesToSlate({ agentType: TeamRuleAgentType.ALL }), true);
    assert.equal(appliesToSlate({ agentType: TeamRuleAgentType.SLATE }), true);
    assert.equal(appliesToSlate({ agentType: TeamRuleAgentType.OTHER }), false);
    assert.equal(appliesToSlate({ agentType: TeamRuleAgentType.UNSPECIFIED }), false);

    const entries = await world.resolver.resolveRules();
    assert.deepEqual(entries, [
      { fullPath: "/global", content: "first", type: { kind: "global" }, source: "team", isRequired: true },
      { fullPath: "/file", content: "pattern", type: { kind: "fileGlobbed", globs: ["src/**/*.ts"] }, source: "team", isRequired: false },
      { fullPath: "/new", content: "global", type: { kind: "global" }, source: "team", isRequired: false },
    ]);
    assert.deepEqual(world.calls.filter(call => call.kind === "rules").map(call => call.teamId), [2, 3]);

    globs.push("test/**/*.ts");
    assert.deepEqual(entries?.[1]?.type, { kind: "fileGlobbed", globs: ["src/**/*.ts"] });
  });

  it("maps missing or null globs to global rules", () => {
    const base = { agentType: TeamRuleAgentType.SLATE, name: "/global", content: "text", isRequired: false };
    assert.deepEqual(teamRuleToEntry({ ...base, globs: null }).type, { kind: "global" });
    assert.deepEqual(teamRuleToEntry(base).type, { kind: "global" });
    assert.deepEqual(mergeRulesByFullPath([[{ fullPath: "/a", value: 1 }], [{ fullPath: "/a", value: 2 }, { fullPath: "/b", value: 3 }]]).map(rule => rule.value), [1, 3]);
  });

  it("treats any team fetch failure as an incomplete batch and reports the value type", async () => {
    const world = clientWorld({
      teams: [{ id: 2, isDirectMember: true }, { id: 3, isDirectMember: true }],
      rules: new Map([[2, [{ agentType: TeamRuleAgentType.SLATE, name: "/partial", content: "not enough", isRequired: false }]]]),
      ruleFailures: new Map([[3, "unreachable"]]),
    });

    assert.equal(await world.resolver.resolveRules(), undefined);
    assert.deepEqual(world.calls.filter(call => call.kind === "rules").map(call => call.teamId), [2, 3]);
    assert.deepEqual(world.reports, [{ extension: "managed_setup", kind: "team_rules_fetch", errorClass: "string" }]);
  });
});
