import assert from "node:assert/strict";
import { describe, it } from "node:test";

import {
  CATALOG_CACHE_TTL_MS,
  isLoopbackHostname,
  validateAuthorizationUrl,
} from "../../source/shared/node/mcp/mcp-catalog-cache.ts";

describe("the address an MCP server sends a user to", () => {
  it("keeps its cache for half a minute", () => {
    assert.equal(CATALOG_CACHE_TTL_MS, 30_000);
  });

  it("knows the two names of this machine", () => {
    assert.equal(isLoopbackHostname("localhost"), true);
    assert.equal(isLoopbackHostname("127.0.0.1"), true);
    for (const host of ["LOCALHOST", "::1", "localhost.", "0.0.0.0", "127.0.0.2", "", "example.com"]) {
      assert.equal(isLoopbackHostname(host), false, host);
    }
  });

  it("accepts https anywhere", () => {
    assert.equal(validateAuthorizationUrl("https://example.com/auth"), "https://example.com/auth");
    assert.equal(validateAuthorizationUrl("HTTPS://Example.COM/auth"), "https://example.com/auth");
  });

  it("accepts plain http only when the server is on this machine too", () => {
    assert.equal(validateAuthorizationUrl("http://localhost:3000/auth", "http://localhost:4000/server"), "http://localhost:3000/auth");
    assert.equal(validateAuthorizationUrl("http://127.0.0.1:3000/auth", "https://127.0.0.1:4000/server"), "http://127.0.0.1:3000/auth");
    assert.equal(validateAuthorizationUrl("http://localhost:3000/auth"), undefined);
    assert.equal(validateAuthorizationUrl("http://localhost:3000/auth", "http://example.com/server"), undefined);
    assert.equal(validateAuthorizationUrl("http://example.com/auth", "http://localhost:3000/server"), undefined);
  });

  it("refuses a text that is not a URL, and reads the authorization text trimmed", () => {
    for (const authUrl of ["", "not a url", "javascript:alert(1)", "ftp://localhost:3000/auth"]) {
      assert.equal(validateAuthorizationUrl(authUrl, "http://localhost:3000/server"), undefined, authUrl);
    }
    assert.equal(validateAuthorizationUrl(" http://localhost:3000/auth ", "http://localhost:3000/server"), "http://localhost:3000/auth");
    assert.equal(validateAuthorizationUrl(String.fromCharCode(160) + "http://localhost:3000/auth", "http://localhost:3000/server"), "http://localhost:3000/auth", "the authorization text is trimmed before the URL reader sees it");
    assert.equal(validateAuthorizationUrl("http://localhost:3000/auth", " http://localhost:3000/server"), "http://localhost:3000/auth", "the platform's URL reader drops surrounding whitespace in either text");
  });
});