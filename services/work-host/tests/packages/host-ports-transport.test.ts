import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { createSlateTransport } from "../../source/host/ports/transport.ts";

describe("the host transport", () => {
  it("starts with nothing remembered", () => {
    const transport = createSlateTransport(() => "id-1");
    assert.equal(transport.lastSentMessageId(), undefined);
    assert.equal(transport.lastReactionApplied(), false);
  });

  it("remembers the id of the last sent message", () => {
    const ingested: unknown[] = [];
    const transport = createSlateTransport((update) => { ingested.push(update); return "id-1"; });
    transport.onUpdate({ type: "send-message", text: "hi" });
    assert.equal(transport.lastSentMessageId(), "id-1");
    assert.deepEqual(ingested, [{ type: "send-message", text: "hi" }]);
    transport.onUpdate({ type: "send-message", text: "again" });
    assert.equal(transport.lastSentMessageId(), "id-1");
  });

  it("remembers nothing when the ingest assigns no id", () => {
    const transport = createSlateTransport(() => undefined);
    transport.onUpdate({ type: "send-message" });
    assert.equal(transport.lastSentMessageId(), undefined, "a missing id is remembered as nothing, not as empty text");
  });

  it("counts only an id that exists as a landed reaction", () => {
    let answer: string | null | undefined = null;
    const transport = createSlateTransport(() => answer as never);
    transport.onUpdate({ type: "react-to-message" });
    assert.equal(transport.lastReactionApplied(), false, "a null id is not a landed reaction");
    answer = "";
    transport.onUpdate({ type: "react-to-message" });
    assert.equal(transport.lastReactionApplied(), true, "an empty id is still an assigned one");
  });

  it("remembers whether the last reaction landed", () => {
    let answer: string | undefined = "id-1";
    const transport = createSlateTransport(() => answer);
    transport.onUpdate({ type: "react-to-message" });
    assert.equal(transport.lastReactionApplied(), true);
    answer = "";
    transport.onUpdate({ type: "react-to-message" });
    assert.equal(transport.lastReactionApplied(), true, "an empty id is still an assigned one");
    answer = undefined;
    transport.onUpdate({ type: "react-to-message" });
    assert.equal(transport.lastReactionApplied(), false);
  });

  it("leaves its memory alone for any other update", () => {
    const transport = createSlateTransport(() => "id-1");
    transport.onUpdate({ type: "send-message" });
    transport.onUpdate({ type: "react-to-message" });
    transport.onUpdate({ type: "edit-message" });
    transport.onUpdate({ type: "typing" });
    assert.equal(transport.lastSentMessageId(), "id-1");
    assert.equal(transport.lastReactionApplied(), true);
  });

  it("keeps one memory per transport and answers with its readers", () => {
    const one = createSlateTransport(() => "one");
    const two = createSlateTransport(() => "two");
    one.onUpdate({ type: "send-message" });
    const { lastSentMessageId, lastReactionApplied, onUpdate } = two;
    onUpdate({ type: "react-to-message" });
    assert.equal(lastSentMessageId(), undefined, "a reaction does not set a sent id");
    assert.equal(one.lastSentMessageId(), "one", "the two transports keep separate memories");
    assert.equal(lastReactionApplied(), true);
    assert.deepEqual(Object.keys(two), ["onUpdate", "lastSentMessageId", "lastReactionApplied"]);
  });

  it("lets a throwing ingest out without changing what it remembered", () => {
    const transport = createSlateTransport(() => { throw new Error("ingest failed"); });
    assert.throws(() => transport.onUpdate({ type: "send-message" }), { message: "ingest failed" });
    assert.equal(transport.lastSentMessageId(), undefined);
  });
});