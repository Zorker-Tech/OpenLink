import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { renderExternalLinksContext } from "../../source/packages/agent/context/external-links-context.ts";

describe("search results the user attached", () => {
  it("are presented as things the agent already knows, with the asking not to disclaim", () => {
    const rendered = renderExternalLinksContext([{ url: "https://x", title: "Title", content: "Body" }]) ?? "";
    assert.equal(rendered.startsWith(`<external_links>
### Potentially Relevant Websearch Results
`), true);
    assert.match(rendered, /respond as if these information are known to you/);
    assert.match(rendered, /always cite any links you referenced/);
    assert.equal(rendered.endsWith("</external_links>"), true);
  });

  it("carry where each one came from, and a rule between them", () => {
    const rendered = renderExternalLinksContext([{ url: "u1", title: "t1", content: "c1" }, { url: "u2", title: "t2", content: "c2" }]) ?? "";
    assert.equal(rendered.includes("Website URL: u1"), true);
    assert.equal(rendered.includes("Website Title: t2"), true);
    assert.equal(rendered.indexOf("c1") < rendered.indexOf("c2"), true);
    assert.equal(rendered.split("____").length - 1, 2);
  });

  it("are nothing at all when there are none", () => {
    assert.equal(renderExternalLinksContext([]), undefined);
  });

  it("render a result that says nothing, rather than leaving it out", () => {
    const rendered = renderExternalLinksContext([{ url: "", title: "", content: "" }]) ?? "";
    assert.equal(rendered.includes("Website URL: "), true);
    assert.equal(rendered.split("____").length - 1, 1);
  });
});
