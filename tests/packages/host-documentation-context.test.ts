import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { renderDocumentationContext } from "../../source/packages/agent/context/documentation-context.ts";

describe("documentation found for a question", () => {
  it("is rendered as context, with the page and the document it came from", () => {
    const rendered = renderDocumentationContext({ chunks: [{ docName: "Guide", pageUrl: "https://example/guide", documentationChunk: "a passage" }] });
    assert.equal(rendered?.startsWith(`<documentation_context>
## Potentially Relevant Documentation:
-------
`), true);
    assert.equal(rendered?.includes("Document Name: Guide"), true);
    assert.equal(rendered?.includes("Document URL: https://example/guide"), true);
    assert.equal(rendered?.includes("a passage"), true);
    assert.equal(rendered?.endsWith("</documentation_context>"), true);
  });

  it("puts a rule after every passage, so two of them cannot be read as one", () => {
    const rendered = renderDocumentationContext({ chunks: [{ docName: "A", pageUrl: "u1", documentationChunk: "one" }, { docName: "B", pageUrl: "u2", documentationChunk: "two" }] }) ?? "";
    assert.equal(rendered.split("____").length - 1, 2);
    assert.equal(rendered.indexOf("one") < rendered.indexOf("two"), true);
  });

  it("is nothing when the question found nothing", () => {
    assert.equal(renderDocumentationContext(undefined), undefined);
    assert.equal(renderDocumentationContext({ chunks: [] }), undefined);
  });

  it("renders a chunk that says nothing, rather than leaving it out", () => {
    const rendered = renderDocumentationContext({ chunks: [{ docName: "", pageUrl: "", documentationChunk: "" }] }) ?? "";
    assert.equal(rendered.includes("Document Name: "), true);
    assert.equal(rendered.split("____").length - 1, 1);
  });
});
