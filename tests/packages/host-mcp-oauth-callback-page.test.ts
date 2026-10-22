import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { renderMcpOAuthErrorPage, renderMcpOAuthSuccessPage } from "../../source/shared/mcp-oauth-callback-page.ts";

describe("the page a browser is shown after a server's authentication", () => {
  it("is a whole page, saying what happened and what to do about it", () => {
    const page = renderMcpOAuthSuccessPage();
    assert.equal(page.startsWith("<!doctype html><html lang=\"en\"><head>"), true);
    assert.equal(page.endsWith("</body></html>"), true);
    assert.match(page, /<title>Authentication complete<\/title>/);
    assert.match(page, /<p class="message">Authorization complete!<\/p>/);
    assert.match(page, /<p class="hint">You can close this tab\.<\/p>/);
    assert.match(page, /<style>[^<]*background:#0c0c0d/);
  });

  it("names the server when it was given one, and does not when it was not", () => {
    assert.match(renderMcpOAuthSuccessPage({ serverName: "Slack" }), /<title>Slack connected<\/title>/);
    assert.match(renderMcpOAuthSuccessPage({ serverName: "   " }), /<title>Authentication complete<\/title>/, "a name of spaces is no name");
    assert.match(renderMcpOAuthSuccessPage({ serverName: "  Slack  " }), /<title>Slack connected<\/title>/, "the padding is not part of the name");
  });

  it("says it failed, and says which server failed", () => {
    const page = renderMcpOAuthErrorPage({ serverName: "Slack" });
    assert.match(page, /<title>Slack — Authentication failed<\/title>/);
    assert.match(page, /OAuth callback failed\./);
    assert.match(page, /Close this tab and try connecting again\./);
    assert.match(renderMcpOAuthErrorPage(), /<title>Authentication failed<\/title>/);
  });

  it("escapes what the page says as well as what it is titled, ampersands included", () => {
    // The sentences are this build's own, but a page is a page: everything that goes into it is escaped.
    const page = renderMcpOAuthSuccessPage();
    assert.equal(page.includes("&amp;"), false, "nothing in the fixed sentences needs escaping");
    const titled = renderMcpOAuthSuccessPage({ serverName: "A & B" });
    assert.equal(titled.includes("A &amp; B connected"), true, "an ampersand in a name is escaped");
  });

  it("does not let a server's name become markup", () => {
    const page = renderMcpOAuthSuccessPage({ serverName: `<script>alert("x")</script>` });
    assert.equal(page.includes("<script>"), false);
    assert.equal(page.includes("&lt;script&gt;"), true);
    assert.equal(page.includes("&quot;x&quot;"), true);
  });
});
