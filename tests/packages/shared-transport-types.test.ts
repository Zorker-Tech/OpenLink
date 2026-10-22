import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { isValidAttachmentUrl } from "../../source/shared/transport-types.ts";

describe("whether a URL names a place an attachment may be read from", () => {
  it("accepts a file on this machine and an https address", () => {
    for (const url of ["file:///tmp/a.png", "FILE:///tmp/a.png", "file:/tmp/a.png", "file:relative.png", "file:", "https://example.com/a.png", "HTTPS://EXAMPLE.COM/A.PNG", "https:example.com", "https://user:pass@example.com/a.png", "https://example.com:8443/a.png", "https://[2001:db8::1]/a.png", "https://bücher.example/a.png"]) {
      assert.equal(isValidAttachmentUrl(url), true, url);
    }
  });

  it("refuses every other scheme", () => {
    for (const url of ["http://example.com/a.png", "data:image/png;base64,AAAA", "mailto:someone@example.com", "ftp://example.com/a.png", "javascript:alert(1)", "ws://example.com/socket", "wss://example.com/socket", "chrome-extension://abc/a.png", "about:blank"]) {
      assert.equal(isValidAttachmentUrl(url), false, url);
    }
  });

  it("refuses a text that is not a URL at all", () => {
    for (const url of ["", " ", "not a url", "//example.com/a.png", "/tmp/a.png", "https://"]) {
      assert.equal(isValidAttachmentUrl(url), false, JSON.stringify(url));
    }
    assert.equal(isValidAttachmentUrl(String.fromCharCode(0) + "https://example.com"), true, "the platform's URL reader drops a leading NUL");
  });
});