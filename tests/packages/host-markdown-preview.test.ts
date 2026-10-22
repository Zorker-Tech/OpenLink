import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { previewTextOf } from "../../source/shared/media/markdown-preview.ts";

describe("the plain text a markdown document stands for", () => {
  it("drops the marks and keeps the words", () => {
    assert.equal(previewTextOf("**bold** and *italic*"), "bold and italic");
    assert.equal(previewTextOf("# Heading"), "Heading");
    assert.equal(previewTextOf("> quoted"), "quoted");
    assert.equal(previewTextOf("- an item"), "an item");
    assert.equal(previewTextOf("`code`"), "code");
  });

  it("keeps what a link or an image says, and loses where it pointed", () => {
    assert.equal(previewTextOf("[the docs](https://example/very/long)"), "the docs");
    assert.equal(previewTextOf("![a picture](img.png)"), "a picture");
    assert.equal(previewTextOf("![a picture](img.png) and [a link](u)"), "a picture and a link");
  });

  it("reads an image before the link inside it, and a bold run before its asterisks", () => {
    assert.equal(previewTextOf("![alt](u)"), "alt", "an image is not a link with a bang");
    assert.equal(previewTextOf("***bold italic***"), "bold italic");
    // Pinned as it behaves: emphasis nested inside a bold run leaves the outer asterisks behind, because the bold rule
    // cannot match a run that contains one.
    assert.equal(previewTextOf("**bold *inside***"), "*bold inside***");
  });

  it("drops the maths delimiters a document may use", () => {
    assert.equal(previewTextOf("$$x + y$$"), "x + y");
    assert.equal(previewTextOf("\\(inline\\)"), "inline");
    assert.equal(previewTextOf("\\[block\\]"), "block");
    assert.equal(previewTextOf("costs \\$5"), "costs $5");
  });

  it("leaves a word alone when its underscores are part of it", () => {
    assert.equal(previewTextOf("snake_case_word"), "snake_case_word");
    assert.equal(previewTextOf("_italic_"), "italic");
  });

  it("is one run of text, with its padding and its gaps collapsed", () => {
    assert.equal(previewTextOf("  spaced    out  "), "spaced out");
    assert.equal(previewTextOf("a\n\nb"), "a b");
    assert.equal(previewTextOf("a | b"), "a b", "a table's pipes are marks too");
    assert.equal(previewTextOf(""), "");
  });
});
