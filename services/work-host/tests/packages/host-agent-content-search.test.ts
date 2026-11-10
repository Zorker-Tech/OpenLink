import assert from "node:assert/strict";
import { describe, it } from "node:test";

import * as search from "../../source/host/extensions/content-search/agent-content-search.ts";
import {
  AGENT_CONTENT_SEARCH_MAX_MATCHES_PER_AGENT,
  AGENT_CONTENT_SEARCH_MAX_RESULTS,
  buildContentSnippet,
  entrySearchText,
  findAgentContentMatches,
} from "../../source/host/extensions/content-search/agent-content-search.ts";

const message = (id: string, content: string, extra: Record<string, unknown> = {}) => ({ id, kind: "message", content, role: "user", ...extra });

describe("searching an agent's transcript", () => {
  it("names the two bounds, and searches the text each kind of entry has", () => {
    assert.equal(AGENT_CONTENT_SEARCH_MAX_MATCHES_PER_AGENT, 5);
    assert.equal(AGENT_CONTENT_SEARCH_MAX_RESULTS, 50);
    assert.deepEqual(Object.keys(search).sort(), [
      "AGENT_CONTENT_SEARCH_MAX_MATCHES_PER_AGENT",
      "AGENT_CONTENT_SEARCH_MAX_RESULTS",
      "buildContentSnippet",
      "entrySearchText",
      "findAgentContentMatches",
    ]);
    assert.equal(entrySearchText(message("m", "the content")), "the content");
    assert.equal(entrySearchText({ id: "m", kind: "message" }), "", "a message with no content contributes nothing");
    assert.equal(entrySearchText({ id: "m", kind: "message", content: undefined } as never), undefined, "a malformed message gives up whatever its content is, as it was");
    assert.equal(entrySearchText({ id: "s", kind: "send-message", message: { type: "text", content: "sent" } }), "sent");
    assert.equal(entrySearchText({ id: "s", kind: "send-message", message: { type: "text" } }), "");
    assert.equal(entrySearchText({ id: "s", kind: "send-message", message: { type: "attachment", content: "not text" } }), "", "only a text send-message contributes");
    assert.equal(entrySearchText({ id: "n", kind: "notice", text: "a notice" }), "a notice");
    assert.equal(entrySearchText({ id: "o", kind: "other", text: "ignored" } as never), "");
    // A kind that happens to be a prototype member is still just an unknown kind.
    assert.equal(entrySearchText({ id: "p", kind: "__proto__", text: "ignored" } as never), "");
  });

  it("builds a snippet around the match, marked where it was cut", () => {
    assert.equal(buildContentSnippet("some text", ""), null);
    assert.equal(buildContentSnippet("some text", "missing"), null);
    assert.equal(buildContentSnippet("needle", "needle"), "needle");
    assert.equal(buildContentSnippet("  lots\n of\twhitespace  around the needle  ", "needle"), "lots of whitespace around the needle", "whitespace is collapsed and trimmed");
    assert.equal(buildContentSnippet("UPPER needle HERE", "needle"), "UPPER needle HERE", "the match is found without case");
    assert.equal(buildContentSnippet("UPPER LOOKS LIKE THIS", "looks"), "UPPER LOOKS LIKE THIS", "an upper-case word matches a lower-case query");
    // A long text is cut to the lead and trail with an ellipsis on each cut side.
    const long = "first second third fourth fifth sixth seventh eighth ninth tenth eleventh twelfth";
    assert.equal(buildContentSnippet(long, "sixth"), "…rst second third fourth fifth sixth seventh eighth ninth tenth eleventh twelfth");
    assert.equal(buildContentSnippet(long, "first"), "first second third fourth fifth sixth seventh eighth ninth tenth …");
    assert.equal(buildContentSnippet(long, "twelfth"), "…h eighth ninth tenth eleventh twelfth", "only the side that was cut is marked");
  });

  it("finds the newest matches first, skips hidden and dead entries, and stops at the limit", () => {
    const entries = [
      message("old", "needle old", { timestampMs: 1 }),
      message("middle", "needle middle", { timestampMs: 2 }),
      message("new", "needle new", { timestampMs: 3 }),
    ];
    assert.deepEqual(findAgentContentMatches(entries, "needle").map((match) => match.entryId), ["new", "middle", "old"]);
    assert.equal(findAgentContentMatches(entries, "").length, 0);
    assert.equal(findAgentContentMatches(entries, "needle", 0).length, 0);
    assert.equal(findAgentContentMatches(entries, "needle", 1).length, 1);
    assert.equal(findAgentContentMatches(Array.from({ length: 9 }, (_, index) => message(`cap-${index}`, "needle")), "needle").length, 5, "the per-agent limit is the default");
    assert.equal(findAgentContentMatches([message("me", "needle")], "needle")[0]?.role, "user", "a message keeps its own role");
    assert.equal(findAgentContentMatches([...entries, message("hidden", "needle hidden", { hiddenOutboundAgentPeerMessage: true })], "needle").some((match) => match.entryId === "hidden"), false);
  });

  it("gives each match its entry, role, time and snippet", () => {
    const matches = findAgentContentMatches([message("m", "needle", { role: "assistant", timestampMs: 9 })], "needle");
    assert.deepEqual(matches, [{ entryId: "m", role: "assistant", timestampMs: 9, snippet: "needle" }]);
    // Anything that is not a message is on the agent's side, and a missing time is zero.
    assert.deepEqual(findAgentContentMatches([{ id: "n", kind: "notice", text: "needle" }], "needle"), [{ entryId: "n", role: "assistant", timestampMs: 0, snippet: "needle" }]);
  });
});