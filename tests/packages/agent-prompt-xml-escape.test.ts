import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { escapePromptXmlText } from "../../source/packages/agent/utils/prompt-xml-escape.ts";

describe("escaping prompt text", () => {
  it("leaves text without markup alone", () => {
    for (const value of ["", "plain text", "quotes \" and ' stay", "new\nline and\ttab", "é ü 工具 💾"]) {
      assert.equal(escapePromptXmlText(value), value);
    }
  });

  it("escapes the three characters that would look like markup", () => {
    assert.equal(escapePromptXmlText("&"), "&amp;");
    assert.equal(escapePromptXmlText("<"), "&lt;");
    assert.equal(escapePromptXmlText(">"), "&gt;");
    assert.equal(escapePromptXmlText("<tag>a & b</tag>"), "&lt;tag&gt;a &amp; b&lt;/tag&gt;");
  });

  it("escapes every occurrence, not just the first", () => {
    assert.equal(escapePromptXmlText("a&b&c<d<e>f>g"), "a&amp;b&amp;c&lt;d&lt;e&gt;f&gt;g");
    assert.equal(escapePromptXmlText("&&<<>>"), "&amp;&amp;&lt;&lt;&gt;&gt;");
  });

  it("applies the ampersand first, so entities it writes stay readable", () => {
    assert.equal(escapePromptXmlText("&amp;"), "&amp;amp;", "an existing entity is text here");
    assert.equal(escapePromptXmlText("&lt;"), "&amp;lt;");
    assert.equal(escapePromptXmlText("<"), "&lt;", "the amp of a written entity is not escaped again");
  });
});
