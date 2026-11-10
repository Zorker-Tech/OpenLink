import assert from "node:assert/strict";
import { describe, it } from "node:test";

import {
  SLATE_ATTACHMENT_KINDS,
  formatAttachmentSentSummary,
  kindPhrase,
  mergeKindCounts,
  type SlateAttachmentKind,
} from "../../source/shared/media/attachments.ts";

describe("the kinds of attachment a message may carry", () => {
  it("are the eleven this build names", () => {
    assert.deepEqual([...SLATE_ATTACHMENT_KINDS], ["image", "video", "audio", "pdf", "markdown", "table", "json", "text", "document", "archive", "file"]);
  });

  it("are said one at a time, or several", () => {
    assert.equal(kindPhrase("image", 1), "1 image");
    assert.equal(kindPhrase("image", 3), "3 images");
    assert.equal(kindPhrase("audio", 1), "1 audio file");
    assert.equal(kindPhrase("pdf", 2), "2 PDFs");
    assert.equal(kindPhrase("file", 0), "0 files");
  });
});

describe("the counts a summary shows", () => {
  it("are one entry per kind, added up", () => {
    assert.deepEqual(mergeKindCounts([{ kind: "image", count: 2 }, { kind: "image", count: 3 }]), [{ kind: "image", count: 5 }]);
    assert.deepEqual(mergeKindCounts([{ kind: "audio", count: 1 }, { kind: "pdf", count: 2 }]), [{ kind: "audio", count: 1 }, { kind: "pdf", count: 2 }]);
  });

  it("count the kinds this build does not name as files", () => {
    assert.deepEqual(mergeKindCounts([{ kind: "hologram", count: 4 }]), [{ kind: "file", count: 4 }]);
    assert.deepEqual(mergeKindCounts([{ kind: "hologram", count: 1 }, { kind: "file", count: 2 }]), [{ kind: "file", count: 3 }]);
  });

  it("leave out a kind that was not counted, and answer nothing for nothing", () => {
    assert.deepEqual(mergeKindCounts([{ kind: "image", count: 0 }, { kind: "image", count: -1 }]), []);
    assert.deepEqual(mergeKindCounts([]), []);
    assert.deepEqual(mergeKindCounts(null), []);
    assert.deepEqual(mergeKindCounts(undefined), []);
  });

  it("do not take a kind named after something every object has as a kind", () => {
    for (const kind of ["toString", "__proto__", "constructor", "hasOwnProperty"]) {
      assert.deepEqual(mergeKindCounts([{ kind, count: 1 }]), [{ kind: "file", count: 1 }], kind);
    }
  });
});

describe("what a surface says a message went out with", () => {
  it("names the one kind it carried", () => {
    assert.equal(formatAttachmentSentSummary(2, [{ kind: "image", count: 2 }]), "Sent 2 images");
    assert.equal(formatAttachmentSentSummary(1, [{ kind: "pdf", count: 1 }]), "Sent 1 PDF");
  });

  it("gives the total and the breakdown when there was more than one kind", () => {
    assert.equal(formatAttachmentSentSummary(6, [{ kind: "audio", count: 1 }, { kind: "pdf", count: 2 }, { kind: "text", count: 3 }]), "Sent 6 files · 1 audio file, 2 PDFs, 3 text files");
  });

  it("says files when nothing was counted, and counts at least one", () => {
    assert.equal(formatAttachmentSentSummary(3), "Sent 3 files");
    assert.equal(formatAttachmentSentSummary(0), "Sent 1 file", "a message that says it sent something sent at least one");
    assert.equal(formatAttachmentSentSummary(-2), "Sent 1 file");
    assert.equal(formatAttachmentSentSummary(2.7), "Sent 2 files", "the count is whole");
  });
});
