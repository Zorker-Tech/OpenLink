import assert from "node:assert/strict";
import { describe, it } from "node:test";

import {
  SLATE_AUTO_REVIEW_SECRET_KEY_PATTERN,
  SLATE_AUTO_REVIEW_SECRET_VALUE_PATTERN,
  redactSlateAutoReviewInlineSecrets as redact,
} from "../../source/shared/slate-auto-review-redact.ts";

describe("redacting what the auto-review classifier is shown", () => {
  it("cuts a URL down to its origin and path", () => {
    assert.equal(redact("curl https://user:pass@example.com/a/b?token=1#frag"), "curl https://example.com/a/b");
    assert.equal(redact("see https://example.com/a/b"), "see https://example.com/a/b", "nothing to cut");
    assert.equal(redact("https://example.com"), "https://example.com/", "the platform's URL reader normalizes it");
    assert.equal(redact("HTTPS://EXAMPLE.COM/A"), "https://example.com/A", "the scheme and host are the platform's");
    assert.equal(redact("go to https://example.com/a, now"), "go to https://example.com/a, now");
    assert.equal(redact("https://example.com/a#section"), "https://example.com/a", "a fragment with no query still goes");
    assert.equal(redact("https://example.com/a?x=1#y"), "https://example.com/a");
  });

  it("leaves a URL that its reader cannot parse alone", () => {
    assert.equal(redact("https://[not-a-host/a"), "https://[not-a-host/a");
  });

  it("replaces the value after a key that says it holds a secret, and only the first value", () => {
    assert.equal(redact("password=hunter2"), "password=…");
    assert.equal(redact("--api-key=abcdef123"), "--api-key=…");
    assert.equal(redact('password="two words"'), "password=…", "a quoted value is one value");
    assert.equal(redact("password\t hunter2"), "password\t …");
    assert.equal(redact("password=one token=two"), "password=… token=…");
    // The key rule replaces the first token after the key, not a token further along the line.
    assert.equal(redact("Authorization: Bearer abcdef"), "Authorization: … abcdef");
    assert.equal(redact("the passwordless path"), "the passwordless path", "the key has to be its own word");
  });

  it("replaces a bearer token and a known token prefix", () => {
    assert.equal(redact("Bearer abcdef"), "Bearer …");
    assert.equal(redact("bearer abcdef"), "Bearer …", "the scheme word is rewritten in its canonical spelling");
    assert.equal(redact("value ghp_abcdef123456"), "value …");
    assert.equal(redact("cost $1 and $2"), "cost $1 and $2", "a replacement-looking text is not a secret");
    assert.equal(redact("echo hello"), "echo hello");
  });

  it("applies the rules in order, so a token behind a keyed value is caught in a second pass", () => {
    // The key rule replaces only "Bearer"; the prefix rule then catches the token that was left behind.
    assert.equal(redact("Authorization: Bearer ghp_abc"), "Authorization: … …");
    assert.equal(redact("secret: ghp_abcdef"), "secret: …", "the key rule took the whole token first");
    assert.equal(redact("Authorization: … abcdef"), "Authorization: … abcdef", "already redacted text stays as it is");
  });

  it("answers the same thing every time", () => {
    const text = "password=one https://user:pass@example.com/a?x=1#f https://example.com/b ghp_abcdef";
    assert.equal(redact(text), redact(text));
  });
});

describe("the patterns the caller judges whole values and key names with", () => {
  it("recognizes a whole secret value by its scheme or prefix and nothing else", () => {
    for (const value of ["bearer abc", "Bearer abc", "sk-abc", "sk_abc", "ghp_abc", "xoxb-abc", "AIzaabc"]) {
      assert.equal(SLATE_AUTO_REVIEW_SECRET_VALUE_PATTERN.test(value), true, value);
    }
    for (const value of ["abc", "", " ", "token=abc", "sk", "abcAIza"]) {
      assert.equal(SLATE_AUTO_REVIEW_SECRET_VALUE_PATTERN.test(value), false, JSON.stringify(value));
    }
  });

  it("recognizes a key name by the words inside it", () => {
    for (const key of ["authorization", "credential", "api_key", "password", "secret", "signature", "token"]) {
      assert.equal(SLATE_AUTO_REVIEW_SECRET_KEY_PATTERN.test(key), true, key);
    }
    assert.equal(SLATE_AUTO_REVIEW_SECRET_KEY_PATTERN.test("monkey"), true, "the word is matched inside a longer name");
    assert.equal(SLATE_AUTO_REVIEW_SECRET_KEY_PATTERN.test("title"), false);
  });
});
