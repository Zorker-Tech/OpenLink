import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { attachmentExtension } from "../../source/shared/media/attachment-open-policy.ts";

describe("the extension an attachment's name ends with", () => {
  it("is the text after the last dot of the file name, lower-cased", () => {
    assert.equal(attachmentExtension("a.png"), "png");
    assert.equal(attachmentExtension("A.PNG"), "png");
    assert.equal(attachmentExtension("archive.tar.gz"), "gz");
    assert.equal(attachmentExtension("report final.PDF"), "pdf");
    assert.equal(attachmentExtension("café.É"), "é");
  });

  it("looks at the file name only, whichever separator the path uses", () => {
    assert.equal(attachmentExtension("/path/to/File.TXT"), "txt");
    assert.equal(attachmentExtension("C:\\Users\\me\\file.PDF"), "pdf");
    assert.equal(attachmentExtension("a/b\\c.D"), "d");
    assert.equal(attachmentExtension("/path/to/noext"), null);
    assert.equal(attachmentExtension("dir.d/file"), null);
    assert.equal(attachmentExtension("dir.d\\file"), null, "a dotted directory does not lend its dot to the file");
    assert.equal(attachmentExtension("C:\\Users\\me.v2\\file"), null);
  });

  it("needs a name before the dot and something after it", () => {
    assert.equal(attachmentExtension(".bashrc"), null, "a leading dot is not an extension");
    assert.equal(attachmentExtension(".hidden.txt"), "txt", "but a later dot is");
    assert.equal(attachmentExtension("a."), null);
    assert.equal(attachmentExtension("a..b"), "b");
    assert.equal(attachmentExtension("..."), null);
    assert.equal(attachmentExtension("dir/file."), null);
  });

  it("has no extension when there is no name at all", () => {
    assert.equal(attachmentExtension(""), null);
    assert.equal(attachmentExtension(" "), null);
    assert.equal(attachmentExtension("noext"), null);
  });
});