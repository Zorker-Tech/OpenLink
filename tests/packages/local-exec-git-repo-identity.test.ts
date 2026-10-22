import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { toHostPath } from "../../source/packages/local-exec/git-repo-identity.ts";

describe("a repository's identity", () => {
  it("is the host and the path of an scp-style remote", () => {
    assert.equal(toHostPath("git@github.com:acme/widgets.git"), "github.com/acme/widgets");
    assert.equal(toHostPath("git@gitlab.com:group/sub/repo.git"), "gitlab.com/group/sub/repo");
    assert.equal(toHostPath("git@github.com:acme/widgets"), "github.com/acme/widgets");
    // An scp remote has no port: its colon starts the path.
    assert.equal(toHostPath("git@host:22/owner/repo"), "host/22/owner/repo");
    assert.equal(toHostPath("git@host"), "host");
  });

  it("drops the scheme, and the port and userinfo with it", () => {
    assert.equal(toHostPath("https://github.com/acme/widgets/"), "github.com/acme/widgets");
    assert.equal(toHostPath("ssh://git@github.com/acme/widgets.git"), "github.com/acme/widgets");
    assert.equal(toHostPath("git+ssh://git@host/owner/repo.git"), "host/owner/repo");
    assert.equal(toHostPath("https://github.com:8443/acme/widgets"), "github.com/acme/widgets");
    assert.equal(toHostPath("https://user:pass@host/owner/repo.git"), "host/owner/repo");
    // The URL parser lower-cases the host and neither the path nor the case of its suffix.
    assert.equal(toHostPath("HTTPS://GitHub.COM/ACME/Widgets.GIT"), "github.com/ACME/Widgets");
  });

  it("treats a bare host and path as a repository address too", () => {
    assert.equal(toHostPath("github.com/acme/widgets"), "github.com/acme/widgets");
    assert.equal(toHostPath("github.com/acme/widgets?ref=main"), "github.com/acme/widgets");
    assert.equal(toHostPath("github.com/acme/widgets#readme"), "github.com/acme/widgets");
    assert.equal(toHostPath("  https://github.com/acme/widgets.git  "), "github.com/acme/widgets", "the padding is trimmed");
  });

  it("keeps the end of the path clean: slashes, one git suffix, and no query", () => {
    assert.equal(toHostPath("https://github.com/acme/widgets.git///"), "github.com/acme/widgets");
    assert.equal(toHostPath("https://host/a/b/c.git.git"), "host/a/b/c.git", "only the last .git is the suffix");
    assert.equal(toHostPath("https://host/.git"), "host");
    assert.equal(toHostPath("https://host/a/.git/"), "host/a");
    assert.equal(toHostPath("https://host/.git//"), "host");
    assert.equal(toHostPath("https://host/a/b?x=/c.git"), "host/a/b", "a query is not a path");
  });

  it("still answers for an address the URL parser refuses", () => {
    assert.equal(toHostPath("https://bad host/repo.git"), "bad host/repo", "the scheme and the suffix are stripped by hand");
    assert.equal(toHostPath("https://bad host/repo.git?ref=main"), "bad host/repo", "and so is the query");
    assert.equal(toHostPath("ssh://host:notaport/x"), "host:notaport/x");
    assert.equal(toHostPath("https://"), "");
    assert.equal(toHostPath(""), "");
  });
});
