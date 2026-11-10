import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { extractRepoNameFromGitUrl } from "../../source/packages/agent-analytics/commit-scoring/git-repo-utils.ts";

/** The repository a remote names, or undefined when it names none. */
const repoOf = (remote: string | undefined) => extractRepoNameFromGitUrl(remote);

describe("a remote that needs no special handling", () => {
  it("names the first two segments of the path", () => {
    assert.equal(repoOf("https://example.com/one/two/three.git"), "one/two");
    assert.equal(repoOf("https://host/path/repo.git/"), "path/repo", "a trailing slash is not a segment");
    assert.equal(repoOf("file:///local/repo.git"), "local/repo");
  });

  it("answers nothing for a path with one segment or none", () => {
    assert.equal(repoOf("https://example.com/one"), undefined);
    assert.equal(repoOf("https://example.com/"), undefined);
    assert.equal(repoOf("https://a/b"), undefined, "the host is not part of the path");
  });

  it("answers nothing at all for a remote that is not one", () => {
    for (const remote of [undefined, "", "not a url at all"]) assert.equal(repoOf(remote), undefined, String(remote));
  });
});

describe("the forms git accepts", () => {
  it("reads a scp-like remote as an ssh URL", () => {
    assert.equal(repoOf("git@github.com:slate/app.git"), "slate/app");
    assert.equal(repoOf("git@gitlab.com:group/sub/project.git"), "group/sub/project");
    assert.equal(repoOf("git@host:path/repo.git"), "path/repo");
  });

  it("leaves an ssh URL as it was written, port and all", () => {
    assert.equal(repoOf("ssh://git@github.com/slate/app.git"), "slate/app");
    assert.equal(repoOf("ssh://git@host:2222/path/repo.git"), "path/repo");
  });

  it("repairs a URL whose slashes were folded into one", () => {
    assert.equal(repoOf("https///github.com/slate/app.git"), "slate/app");
    assert.equal(repoOf("http///gitlab.com/g/p"), "g/p");
  });
});

describe("the hosts that disagree about their paths", () => {
  it("takes a github repository as its two segments, and reads the host whatever case it is written in", () => {
    assert.equal(repoOf("https://github.com/a/b/c/d.git"), "a/b");
    assert.equal(repoOf("https://GitHub.com/Slate/App.git"), "Slate/App");
    assert.equal(repoOf("https://github.example.com/o/r.git"), "o/r");
    assert.equal(repoOf("https://acme.ghe.com/o/r.git"), "o/r");
    assert.equal(repoOf("https://github.com/onlyone"), undefined);
    assert.equal(repoOf("https://github.com/"), undefined);
  });

  it("takes a gitlab repository as the whole path, subgroups included", () => {
    assert.equal(repoOf("https://gitlab.com/group/sub/project.git"), "group/sub/project");
    assert.equal(repoOf("https://gitlab.com/onlyone"), "onlyone");
  });

  it("drops bitbucket's scm prefix, and takes two segments otherwise", () => {
    assert.equal(repoOf("https://bitbucket.org/team/repo.git"), "team/repo");
    assert.equal(repoOf("https://stash.acme.com/scm/team/repo.git"), "team/repo");
    assert.equal(repoOf("https://stash.acme.com/team/repo"), "team/repo");
    assert.equal(repoOf("https://stash.acme.com/scm/team"), "scm/team", "scm is only a prefix when a repository follows it");
  });

  it("drops gerrit's own prefixes, whether they are in the host or the path", () => {
    assert.equal(repoOf("https://gerrit.acme.com/gerrit/a/project/name"), "project/name");
    assert.equal(repoOf("https://gerrit.acme.com/a/project"), "project");
    assert.equal(repoOf("https://gerrit.acme.com/project"), "project");
    assert.equal(repoOf("https://review.acme.com/gerrit/project/x"), "project/x");
  });

  it("drops azure's _git segment and its ssh version prefix", () => {
    assert.equal(repoOf("https://dev.azure.com/org/project/_git/repo"), "org/project/repo");
    assert.equal(repoOf("https://org.visualstudio.com/project/_git/repo"), "project/repo", "the organisation is the host there, not a segment");
    assert.equal(repoOf("git@ssh.dev.azure.com:v3/org/project/repo"), "org/project/repo");
    assert.equal(repoOf("https://dev.azure.com/org/_git/repo"), "org/repo");
  });

  it("reads azure's prefixes in the order the host writes them", () => {
    // The version prefix is only a prefix when it comes first; _git is dropped wherever it is, in any case.
    assert.equal(repoOf("https://dev.azure.com/o/_git/v3/x"), "o/v3/x");
    assert.equal(repoOf("git@ssh.dev.azure.com:v3/_git/r"), "r", "the version prefix comes off before _git is looked for");
    assert.equal(repoOf("git@ssh.dev.azure.com:_git/v3/r"), "v3/r");
    assert.equal(repoOf("https://dev.azure.com/o/_GIT/r"), "o/r");
  });

  it("answers nothing for an azure path that names no repository", () => {
    assert.equal(repoOf("https://dev.azure.com/org/project"), "org/project");
    assert.equal(repoOf("https://dev.azure.com/"), undefined);
  });
});

describe("a gitlab remote this platform speaks", () => {
  it("answers from its project when that names a namespace", () => {
    assert.equal(repoOf("gitlab-remote://local?project=group/name"), "group/name");
  });

  it("answers nothing when the project has no namespace, rather than guessing one", () => {
    assert.equal(repoOf("gitlab-remote://local?project=nogroup"), undefined);
    assert.equal(repoOf("gitlab-remote://local?project="), undefined);
  });
});
