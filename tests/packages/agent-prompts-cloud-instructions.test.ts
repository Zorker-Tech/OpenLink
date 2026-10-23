import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { CloudInstructionsSection, CloudTaskInstructions } from "../../source/packages/agent/prompts/cloud-task-instructions.ts";
import { renderContent } from "../../source/packages/prompt-jsx/render-prompt.ts";

const textOf = (value: unknown): string => renderContent(value as never);
const props = (overrides: Record<string, unknown> = {}) => ({
  gitRepos: [{ path: "/work/repo", branchName: "feature-1", baseBranch: "main", remoteUrl: "https://github.com/slate/app.git" }],
  designatedBranches: undefined,
  branchPrefix: undefined,
  branchSuffix: undefined,
  allowMultipleBranches: false,
  preferCurrentBranchInMultiPrMode: false,
  toolInfo: undefined,
  staleBuildGitRefs: undefined,
  ...overrides,
});

describe("the cloud instructions", () => {
  it("pulls the AGENTS.md content into its own section", () => {
    const rendered = textOf(CloudInstructionsSection({ cloudRuleContent: "rule one" }));
    assert.equal(rendered.includes("cloud_instructions"), true);
    assert.equal(rendered.includes("AGENTS.md contents:"), true);
    assert.equal(rendered.includes("rule one"), true);
  });

  it("names the repository and branch the agent develops on", () => {
    const rendered = textOf(CloudTaskInstructions(props()));
    assert.equal(rendered.includes("slate/app"), true);
    assert.equal(rendered.includes("feature-1"), true);
    assert.equal(rendered.includes("base branch"), true);
    assert.equal(rendered.includes("git symbolic-ref --short HEAD"), false);
  });

  it("reports a detached head as unknown and asks for the branch name", () => {
    const rendered = textOf(CloudTaskInstructions(props({ gitRepos: [{ branchName: "HEAD" }] })));
    assert.equal(rendered.includes("unknown-branch"), true);
    assert.equal(rendered.includes("git symbolic-ref --short HEAD"), true);
    assert.equal(rendered.includes("unknown-repo"), true);
  });

  it("reads the repository label from the shapes a host uses", () => {
    const cases: Array<[string, string]> = [
      ["https://github.com/slate/app.git", "slate/app"],
      ["git@github.com:slate/app.git", "slate/app"],
      ["https://gitlab.com/group/sub/app.git", "group/sub/app"],
      ["https://bitbucket.org/team/app.git", "team/app"],
      ["https://dev.azure.com/org/project/_git/app", "org/project/app"],
      ["https://gerrit.example.com/gerrit/app", "app"],
      ["gitlab-remote://host?project=group/app", "group/app"],
    ];
    for (const [remoteUrl, label] of cases) {
      const rendered = textOf(CloudTaskInstructions(props({ gitRepos: [{ path: "/work/repo", branchName: "b", remoteUrl }] })));
      assert.equal(rendered.includes(label), true, remoteUrl);
    }
  });

  it("lists a branch per repository in a multi-repo workspace", () => {
    const repos = [
      { path: "/work/one", branchName: "branch-one", remoteUrl: "https://github.com/slate/one" },
      { path: "/work/two", branchName: "branch-two", remoteUrl: "https://github.com/slate/two" },
    ];
    const rendered = textOf(CloudTaskInstructions(props({
      allowMultipleBranches: true,
      gitRepos: repos,
      designatedBranches: repos,
    })));
    assert.equal(rendered.includes("multiple git repositories"), true);
    assert.equal(rendered.includes("slate/one"), true);
    assert.equal(rendered.includes("slate/two"), true);
    assert.equal(rendered.includes("/work/one"), true);
    assert.equal(rendered.includes("branch-one"), true);
  });

  it("uses the PR management tool when one is offered", () => {
    const repos = [
      { path: "/work/one", branchName: "branch-one", remoteUrl: "https://github.com/slate/one" },
      { path: "/work/two", branchName: "branch-two", remoteUrl: "https://github.com/slate/two" },
    ];
    const rendered = textOf(CloudTaskInstructions(props({
      allowMultipleBranches: true,
      gitRepos: repos,
      designatedBranches: repos,
      toolInfo: { allTools: { PR_MANAGEMENT: { name: "pr_tool" } } },
    })));
    assert.equal(rendered.includes("pr_tool"), true);
    assert.equal(rendered.includes("Do not use `gh`"), true);
  });

  it("carries the snapshot staleness notice only when asked", () => {
    const quiet = textOf(CloudTaskInstructions(props()));
    assert.equal(quiet.includes("Pre-built snapshot git staleness:"), false);
    const allRefs = textOf(CloudTaskInstructions(props({ staleBuildGitRefs: "all_refs" })));
    assert.equal(allRefs.includes("Pre-built snapshot git staleness:"), true);
    assert.equal(allRefs.includes("typically by an hour or two"), true);
    const startedRefs = textOf(CloudTaskInstructions(props({ staleBuildGitRefs: "started_refs" })));
    assert.equal(startedRefs.includes("best-effort refresh"), true);
  });

  it("builds the branch template from the prefix and suffix", () => {
    const rendered = textOf(CloudTaskInstructions(props({ allowMultipleBranches: true, branchPrefix: "slate/", branchSuffix: "-x" })));
    assert.equal(rendered.includes("slate/<descriptive-name>-x"), true);
    assert.equal(rendered.includes("Use the prefix `slate/`"), true);
    assert.equal(rendered.includes("Append the suffix `-x`"), true);
  });
});
