import assert from "node:assert/strict";
import { test } from "node:test";

import { canonicalRepoHost, parseAndValidateScmUrl, parseGitUrl, toScmSshUrl } from "../../source/packages/plugin-install/git-url-parsing.ts";

test("repository parsing accepts HTTPS, SSH, scp-style and bare-host spellings", () => {
  const expected = { provider: "github", owner: "acme", repo: "widgets", host: "github.com" };
  assert.deepEqual(parseGitUrl("https://github.com/acme/widgets.git"), expected);
  assert.deepEqual(parseGitUrl("ssh://git@github.com/acme/widgets.git"), expected);
  assert.deepEqual(parseGitUrl("git@github.com:acme/widgets.git"), expected);
  assert.deepEqual(parseGitUrl("github.com/acme/widgets.git"), expected);
});

test("repository parsing identifies supported forges and generic hosts", () => {
  assert.deepEqual(parseGitUrl("gitlab.com/team/widgets"), { provider: "gitlab", owner: "team", repo: "widgets", host: "gitlab.com" });
  assert.deepEqual(parseGitUrl("https://bitbucket.org/team/widgets"), { provider: "bitbucket", owner: "team", repo: "widgets", host: "bitbucket.org" });
  assert.deepEqual(parseGitUrl("https://dev.azure.com/org/project/_git/widgets"), { provider: "azure_devops", owner: "org", repo: "project", host: "dev.azure.com" });
  assert.deepEqual(parseGitUrl("https://git.example/team/widgets"), { provider: "generic", owner: "team", repo: "widgets", host: "git.example" });
});

test("repository parsing strips a case-insensitive git suffix and ignores subpaths", () => {
  assert.deepEqual(parseGitUrl("https://github.com/acme/widgets.GIT/tree/main"), {
    provider: "github",
    owner: "acme",
    repo: "widgets",
    host: "github.com",
  });
});

test("server SCM prefixes are removed for parsing and kept in the normalized identity", () => {
  assert.deepEqual(parseGitUrl("https://github.com/scm/acme/widgets"), { provider: "github", owner: "acme", repo: "widgets", host: "github.com" });
  assert.deepEqual(parseAndValidateScmUrl("https://github.com/scm/acme/widgets"), {
    url: "https://github.com/scm/acme/widgets",
    owner: "acme",
    repo: "widgets",
    host: "github.com",
    provider: "github",
  });
});

test("repository parsing refuses malformed addresses and paths without a repository pair", () => {
  for (const input of ["", "not a url", "https://github.com", "https://github.com/acme", "https://github.com/"]) {
    assert.equal(parseGitUrl(input), null, input);
  }
});

test("a repository root path is collapsed to the provider's canonical URL", () => {
  assert.deepEqual(parseAndValidateScmUrl("  https://www.github.com/acme/widgets.git/tree/main  "), {
    url: "https://github.com/acme/widgets",
    owner: "acme",
    repo: "widgets",
    host: "github.com",
    provider: "github",
  });
});

test("empty and malformed source-control inputs have distinct errors", () => {
  assert.deepEqual(parseAndValidateScmUrl("  "), { error: "URL cannot be empty" });
  assert.deepEqual(parseAndValidateScmUrl("not a url at all"), {
    error: "Invalid URL format. Expected: github.com/owner/repo or gitlab.com/namespace/repo",
  });
});

test("GitLab keeps nested namespaces and removes special route suffixes", () => {
  assert.deepEqual(parseAndValidateScmUrl("https://gitlab.com/team/platform/widgets.git/-/tree/main"), {
    url: "https://gitlab.com/team/platform/widgets",
    owner: "team",
    repo: "widgets",
    host: "gitlab.com",
    provider: "gitlab",
  });
  assert.deepEqual(parseAndValidateScmUrl("https://gitlab.com/team/platform/widgets"), {
    url: "https://gitlab.com/team/platform/widgets",
    owner: "team",
    repo: "widgets",
    host: "gitlab.com",
    provider: "gitlab",
  });
});

test("GitLab allows a self-hosted forge and preserves its HTTPS port", () => {
  assert.deepEqual(parseAndValidateScmUrl("https://gitlab.company.test:8443/group/repo.git"), {
    url: "https://gitlab.company.test:8443/group/repo",
    owner: "group",
    repo: "repo",
    host: "gitlab.company.test:8443",
    provider: "gitlab",
  });
});

test("an invalid GitLab route reports the provider-specific shape", () => {
  assert.deepEqual(parseAndValidateScmUrl("https://gitlab.com/team/-/issues"), {
    error: "Invalid GitLab repository URL format. Expected: https://gitlab.com/namespace/repo",
  });
});

test("Bitbucket cloud removes suffixes and emits workspace/repository identity", () => {
  assert.deepEqual(parseAndValidateScmUrl("git@bitbucket.org:team/widgets.git"), {
    url: "https://bitbucket.org/team/widgets",
    owner: "team",
    repo: "widgets",
    host: "bitbucket.org",
    provider: "bitbucket",
  });
  assert.deepEqual(parseAndValidateScmUrl("https://bitbucket.org/team/widgets/"), {
    url: "https://bitbucket.org/team/widgets",
    owner: "team",
    repo: "widgets",
    host: "bitbucket.org",
    provider: "bitbucket",
  });
});

test("Bitbucket path segments are decoded and safely re-encoded", () => {
  assert.deepEqual(parseAndValidateScmUrl("https://bitbucket.org/team%20space/widget%20lib.git"), {
    url: "https://bitbucket.org/team%20space/widget%20lib",
    owner: "team%20space",
    repo: "widget%20lib",
    host: "bitbucket.org",
    provider: "bitbucket",
  });
});

test("Bitbucket account pages are not treated as repositories", () => {
  assert.deepEqual(parseAndValidateScmUrl("https://bitbucket.org/account/profile"), {
    error: "Invalid Bitbucket repository URL format. Expected: https://bitbucket.org/{workspace}/{repo}",
  });
});

test("Azure DevOps identifies the repository after _git", () => {
  assert.deepEqual(parseAndValidateScmUrl("https://dev.azure.com/acme/platform/_git/widgets.git"), {
    url: "https://dev.azure.com/acme/platform/_git/widgets",
    owner: "acme",
    repo: "widgets",
    host: "dev.azure.com",
    provider: "azure_devops",
    project: "platform",
  });
});

test("Azure DevOps uses the repository as the project when the project segment is absent", () => {
  assert.deepEqual(parseAndValidateScmUrl("https://dev.azure.com/acme/_git/widgets"), {
    url: "https://dev.azure.com/acme/widgets/_git/widgets",
    owner: "acme",
    repo: "widgets",
    host: "dev.azure.com",
    provider: "azure_devops",
    project: "widgets",
  });
});

test("an Azure DevOps URL without _git gets a provider-specific error", () => {
  assert.deepEqual(parseAndValidateScmUrl("https://dev.azure.com/acme/platform"), {
    error: "Invalid Azure DevOps repository URL format. Expected: https://dev.azure.com/{organization}/{project}/_git/{repo}",
  });
});

test("unknown hosts remain GitHub-compatible unless their host names identify an unsupported forge", () => {
  assert.deepEqual(parseAndValidateScmUrl("https://git.example/acme/widgets.git"), {
    url: "https://git.example/acme/widgets",
    owner: "acme",
    repo: "widgets",
    host: "git.example",
    provider: "github",
  });
  assert.deepEqual(parseAndValidateScmUrl("https://gitea.example/team/widgets"), {
    error: "Only GitHub, GitLab, Bitbucket, and Azure DevOps URLs are currently supported. Gitea/Codeberg is not supported yet.",
  });
});

test("unsupported host families name the matching forge in the error", () => {
  assert.equal((parseAndValidateScmUrl("https://bitbucket.company/team/repo") as { error: string }).error.endsWith("Bitbucket is not supported yet."), true);
  assert.equal((parseAndValidateScmUrl("https://dev.azure.company/org/repo") as { error: string }).error.endsWith("Azure DevOps is not supported yet."), true);
  assert.equal((parseAndValidateScmUrl("https://codeberg.org/team/repo") as { error: string }).error.endsWith("Gitea/Codeberg is not supported yet."), true);
  assert.deepEqual(parseAndValidateScmUrl("https://azure.example/org/repo"), {
    url: "https://azure.example/org/repo",
    owner: "org",
    repo: "repo",
    host: "azure.example",
    provider: "github",
  });
});

test("GitHub-like private subdomains canonicalize to the public host spelling", () => {
  assert.equal(canonicalRepoHost("WWW.GitHub.com"), "github.com");
  assert.equal(canonicalRepoHost("api.github.com"), "github.com");
  assert.equal(canonicalRepoHost("git.example"), "git.example");
});

test("GitHub and compatible repositories can be emitted as SSH remotes", () => {
  assert.equal(toScmSshUrl("https://github.com/acme/widgets.git"), "git@github.com:acme/widgets.git");
  assert.equal(toScmSshUrl("https://github.enterprise.test/acme/widgets"), "git@github.enterprise.test:acme/widgets.git");
  assert.equal(toScmSshUrl("https://git.example/acme/widgets"), "git@git.example:acme/widgets.git");
});

test("GitLab emits its full namespace over SSH and drops the port", () => {
  assert.equal(toScmSshUrl("https://gitlab.example.test:8443/team/platform/widgets.git"), "git@gitlab.example.test:team/platform/widgets.git");
});

test("Bitbucket, Azure DevOps, and refused hosts have no SSH form", () => {
  assert.equal(toScmSshUrl("https://bitbucket.org/team/widgets"), null);
  assert.equal(toScmSshUrl("https://dev.azure.com/acme/platform/_git/widgets"), null);
  assert.equal(toScmSshUrl("https://gitea.example/team/widgets"), null);
  assert.equal(toScmSshUrl("not a url"), null);
});

test("credentials and query fragments do not leak into canonical repository URLs", () => {
  const value = parseAndValidateScmUrl("https://user:secret@github.com/acme/widgets.git?ref=main#readme");
  assert.deepEqual(value, {
    url: "https://github.com/acme/widgets",
    owner: "acme",
    repo: "widgets",
    host: "github.com",
    provider: "github",
  });
  assert.equal(JSON.stringify(value).includes("secret"), false);
});
