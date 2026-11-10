import assert from "node:assert/strict";
import { describe, it } from "node:test";

import * as sanitizing from "../../source/packages/agent/prompts/remote-url-sanitizing.ts";
import { sanitizeRemoteUrlForPrompt } from "../../source/packages/agent/prompts/remote-url-sanitizing.ts";

describe("a remote url written into a prompt", () => {
  it("loses the user name and the token it was reached with, and keeps the rest", () => {
    assert.equal(sanitizeRemoteUrlForPrompt("https://user:token@github.com/acme/widgets.git"), "https://github.com/acme/widgets.git");
    assert.equal(sanitizeRemoteUrlForPrompt("https://user@github.com/acme/widgets.git"), "https://github.com/acme/widgets.git");
    assert.equal(sanitizeRemoteUrlForPrompt("https://:token@github.com/acme/widgets.git"), "https://github.com/acme/widgets.git");
    assert.equal(sanitizeRemoteUrlForPrompt("ssh://git:token@host/owner/repo.git"), "ssh://host/owner/repo.git");
    // Only the userinfo goes: the port, the path, the query and the fragment are still the remote's.
    assert.equal(
      sanitizeRemoteUrlForPrompt("https://user:token@host:8443/owner/repo.git?ref=main#frag"),
      "https://host:8443/owner/repo.git?ref=main#frag",
    );
  });

  it("is trimmed, and a text that is not a url is left as it came", () => {
    assert.equal(sanitizeRemoteUrlForPrompt("  https://user:token@host/owner/repo  "), "https://host/owner/repo");
    assert.equal(sanitizeRemoteUrlForPrompt("   "), "");
    assert.equal(sanitizeRemoteUrlForPrompt(""), "");
    // An scp remote is not a URL to the parser; it is still worth naming, so it is kept as written rather than dropped.
    assert.equal(sanitizeRemoteUrlForPrompt("git@github.com:acme/widgets.git"), "git@github.com:acme/widgets.git");
    assert.equal(sanitizeRemoteUrlForPrompt("not a url"), "not a url");
    assert.equal(sanitizeRemoteUrlForPrompt("  not a url  "), "not a url", "the trimming happens before the parser is asked");
  });

  it("answers with the url's own normal form", () => {
    // The parser's normal form is part of the answer: the host is lower-cased and a bare host gains its slash.
    assert.equal(sanitizeRemoteUrlForPrompt("HTTPS://User:Token@GitHub.COM/Acme/Widgets.GIT"), "https://github.com/Acme/Widgets.GIT");
    assert.equal(sanitizeRemoteUrlForPrompt("https://github.com"), "https://github.com/");
  });

  it("exposes the one reader, and nothing else at runtime", () => {
    assert.deepEqual(Object.keys(sanitizing).sort(), ["sanitizeRemoteUrlForPrompt"]);
  });
});
