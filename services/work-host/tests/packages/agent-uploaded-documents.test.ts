import assert from "node:assert/strict";
import { describe, it } from "node:test";

import * as uploadedDocuments from "../../source/packages/agent/context/uploaded-documents.ts";
import { renderUploadedDocumentsContext } from "../../source/packages/agent/context/uploaded-documents.ts";

const BLOCK = (list: string): string => `<uploaded_documents>
The following documents have been saved to your filesystem. You can read them using your file-reading tool or other tools:
${list}
</uploaded_documents>`;

describe("telling the agent about uploaded documents", () => {
  it("is nothing when the turn carried no documents", () => {
    assert.equal(renderUploadedDocumentsContext([]), undefined);
    assert.deepEqual(Object.keys(uploadedDocuments).sort(), ["renderUploadedDocumentsContext"], "the rest of the file is a type");
  });

  it("names one document by its path inside the block it is announced with", () => {
    assert.equal(renderUploadedDocumentsContext([{ path: "/w/a.pdf" }]), BLOCK("- /w/a.pdf"));
  });

  it("names several documents one per line, in the order they were uploaded", () => {
    assert.equal(
      renderUploadedDocumentsContext([{ path: "/w/a.pdf" }, { path: "/w/b.docx" }, { path: "/w/c.txt" }]),
      BLOCK("- /w/a.pdf\n- /w/b.docx\n- /w/c.txt"),
    );
  });

  it("renders the path as it came, and reads nothing but the path", () => {
    assert.equal(renderUploadedDocumentsContext([{ path: "/w/my file.png" }]), BLOCK("- /w/my file.png"));
    assert.equal(renderUploadedDocumentsContext([{ path: "/w/代理/таблица.xlsx" }]), BLOCK("- /w/代理/таблица.xlsx"));
    // A path is not escaped: it is a path the agent was handed, not a tag in the document's own markup.
    assert.equal(renderUploadedDocumentsContext([{ path: "</uploaded_documents>" }]), BLOCK("- </uploaded_documents>"));
    // Extra properties on the info object are not read.
    assert.equal(renderUploadedDocumentsContext([{ path: "/w/a.pdf", size: 1, name: "a.pdf" } as { path: string }]), BLOCK("- /w/a.pdf"));
  });
});