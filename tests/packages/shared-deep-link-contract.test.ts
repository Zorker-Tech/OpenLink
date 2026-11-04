import assert from "node:assert/strict";
import { describe, it } from "node:test";

import {
  SLATE_DEEP_LINK_MAX_LENGTH,
  SLATE_HTTPS_DEEP_LINK_ORIGIN,
  SLATE_HTTPS_DEEP_LINK_PATH_PREFIX,
  SLATE_OPEN_DEEP_LINK_URL,
  canonicalSlateDeepLinkUrl,
  parseSlateDeepLink,
} from "../../source/shared/deep-link.ts";
import { SLATE_PLUGIN_DEEP_LINK_PATH } from "../../source/shared/desktop.ts";

const httpsBase = `https://${new URL(SLATE_HTTPS_DEEP_LINK_ORIGIN).host}${SLATE_HTTPS_DEEP_LINK_PATH_PREFIX}`;

describe("Slate deep-link contract", () => {
  it("reads the three protocol routes and returns a canonical URL for each", () => {
    const open = parseSlateDeepLink("slate://app/v1/open");
    assert.deepEqual(open?.link, { version: 1, route: "open", source: "protocol" });
    assert.equal(open?.canonicalUrl, SLATE_OPEN_DEEP_LINK_URL);

    const plugin = parseSlateDeepLink(`slate://app${SLATE_PLUGIN_DEEP_LINK_PATH}?id=42`);
    assert.deepEqual(plugin?.link, { version: 1, route: "plugin-add", pluginId: "42", source: "protocol" });
    assert.equal(plugin?.canonicalUrl, "slate://app/v1/plugin/add?id=42");

    const info = parseSlateDeepLink("slate://app/v1/info?topic=deep-links");
    assert.deepEqual(info?.link, { version: 1, route: "info", topic: "deep-links", source: "protocol" });
    assert.equal(info?.canonicalUrl, canonicalSlateDeepLinkUrl(info!.link));
  });

  it("accepts the matching HTTPS routes but canonicalizes them to the protocol URL", () => {
    const open = parseSlateDeepLink(`${httpsBase}/v1/open`);
    assert.deepEqual(open?.link, { version: 1, route: "open", source: "https" });
    assert.equal(open?.canonicalUrl, SLATE_OPEN_DEEP_LINK_URL);

    const plugin = parseSlateDeepLink(`${httpsBase}${SLATE_PLUGIN_DEEP_LINK_PATH}?id=17`);
    assert.deepEqual(plugin?.link, { version: 1, route: "plugin-add", pluginId: "17", source: "https" });
    assert.equal(plugin?.canonicalUrl, "slate://app/v1/plugin/add?id=17");

    const info = parseSlateDeepLink(`${httpsBase}/v1/info?topic=deep-links`);
    assert.deepEqual(info?.link, { version: 1, route: "info", topic: "deep-links", source: "https" });
    assert.equal(info?.canonicalUrl, "slate://app/v1/info?topic=deep-links");
  });

  it("enforces exact query contracts and rejects duplicate or surplus values", () => {
    for (const raw of [
      "slate://app/v1/info",
      "slate://app/v1/info?topic=other",
      "slate://app/v1/info?topic=deep-links&topic=deep-links",
      "slate://app/v1/info?topic=deep-links&extra=1",
      "slate://app/v1/open?x=1",
      "slate://app/v1/open?toString=value",
      "slate://app/v1/open?__proto__=value",
      "slate://app/v1/plugin/add",
      "slate://app/v1/plugin/add?id=42&id=42",
      "slate://app/v1/plugin/add?id=42&extra=1",
    ]) assert.equal(parseSlateDeepLink(raw), null, raw);
  });

  it("decodes permitted query escapes and canonicalizes the decoded value", () => {
    const info = parseSlateDeepLink("slate://app/v1/info?topic=deep%2Dlinks");
    assert.deepEqual(info?.link, { version: 1, route: "info", topic: "deep-links", source: "protocol" });
    assert.equal(info?.canonicalUrl, "slate://app/v1/info?topic=deep-links");

    const plugin = parseSlateDeepLink("slate://app/v1/plugin/add?id=%34%32");
    assert.deepEqual(plugin?.link, { version: 1, route: "plugin-add", pluginId: "42", source: "protocol" });
    assert.equal(plugin?.canonicalUrl, "slate://app/v1/plugin/add?id=42");
  });

  it("requires plugin ids to be one to nineteen decimal digits", () => {
    assert.equal(parseSlateDeepLink("slate://app/v1/plugin/add?id=0")?.link.route, "plugin-add");
    assert.equal(parseSlateDeepLink(`slate://app/v1/plugin/add?id=${"9".repeat(19)}`)?.link.route, "plugin-add");
    for (const id of ["", "x", "1a", "1".repeat(20)]) {
      assert.equal(parseSlateDeepLink(`slate://app/v1/plugin/add?id=${id}`), null, id);
    }
  });

  it("rejects invalid input types, non-printable text, fragments, backslashes and malformed escapes", () => {
    for (const value of [undefined, null, 12, {}, "", "not a link", "slate://app/v1/open path",
      "slate://app/v1/open\n", "slate://app/v1/opén", "slate://app/v1/open#section",
      "slate://app/v1\\open", "slate://app/v1/open?x=%2", "slate://app/v1/open?x=%GG"]) {
      assert.equal(parseSlateDeepLink(value), null, String(value));
    }
  });

  it("rejects credentials, non-default ports, foreign hosts, and unrelated schemes", () => {
    for (const raw of [
      "slate://user@app/v1/open",
      "slate://user:secret@app/v1/open",
      "slate://app:1234/v1/open",
      "slate://elsewhere/v1/open",
      "http://app/v1/open",
      "https://elsewhere.example/slate/link/v1/open",
      "https://slate.invalid:8443/slate/link/v1/open",
      "https://user@slate.invalid/slate/link/v1/open",
    ]) assert.equal(parseSlateDeepLink(raw), null, raw);
  });

  it("rejects path escapes and dot segments before URL normalization", () => {
    for (const raw of [
      "slate://app/v1/%6fpen",
      "slate://app/v1/../v1/open",
      "slate://app/v1/./open",
      "https://slate.invalid/slate/link/v1/%6fpen",
      "https://slate.invalid/slate/link/v1/../v1/open",
    ]) assert.equal(parseSlateDeepLink(raw), null, raw);
  });

  it("accepts the exact maximum input length and rejects the next character", () => {
    const prefix = "slate://app/v1/open?";
    const exact = prefix + "&".repeat(SLATE_DEEP_LINK_MAX_LENGTH - prefix.length);
    assert.equal(exact.length, SLATE_DEEP_LINK_MAX_LENGTH);
    assert.equal(parseSlateDeepLink(exact)?.link.route, "open");
    assert.equal(parseSlateDeepLink(`${exact}&`), null);
  });
});
