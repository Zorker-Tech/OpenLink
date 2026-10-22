import assert from "node:assert/strict";
import { describe, it } from "node:test";

import {
  SLATE_AUTO_REVIEW_STALE,
  SLATE_AUTO_REVIEW_STALE_MESSAGE,
  SLATE_REACTION_AGENT,
  SLATE_REACTION_SELF,
  isHiddenOutboundPeerMessage,
  isOutboundPeerMessage,
  isPeerMessage,
  mainTranscriptOf,
  raisesUserActivity,
  settledAutoReviewEntry,
  settledToolPermissionEntry,
  threadOf,
} from "../../source/shared/transcript.ts";

type Entry = Parameters<typeof settledAutoReviewEntry>[0];

const approval = (status: string, requestId = "r1"): Entry => ({ kind: "send-message", message: { type: "auto-review-approval", approval: { requestId, status } } });
const permission = (status: string, requestId = "r2"): Entry => ({ kind: "send-message", message: { type: "local-tool-permission", ask: { requestId, status } } });

describe("settling what a surface is still showing", () => {
  it("settles the one entry that is still pending, and only the one whose request was named", () => {
    const settled = settledAutoReviewEntry(approval("pending"), "expired", "r1");
    assert.deepEqual(settled?.message?.["approval"], { requestId: "r1", status: "expired" });
    assert.equal(settledAutoReviewEntry(approval("pending"), "expired", "other"), null);
    assert.equal(settledAutoReviewEntry(approval("settled"), "expired"), null, "an entry that is not pending is left alone");
    assert.equal(settledAutoReviewEntry(permission("pending"), "expired"), null, "the wrong kind of entry is not touched");
    assert.equal(settledAutoReviewEntry({ kind: "send-message", message: { type: "notice", approval: { requestId: "r1", status: "pending" } } }, "expired"), null, "a message of another type is not touched");
    assert.equal(settledToolPermissionEntry({ kind: "send-message", message: { type: "auto-review-approval", ask: { requestId: "r2", status: "pending" } } }, "denied"), null);
  });

  it("settles a tool permission by the same rule", () => {
    assert.deepEqual(settledToolPermissionEntry(permission("pending"), "denied")?.message?.["ask"], { requestId: "r2", status: "denied" });
    assert.equal(settledToolPermissionEntry(approval("pending"), "denied"), null);
  });

  it("leaves the entry it was given as it was", () => {
    const entry = approval("pending");
    const settled = settledAutoReviewEntry(entry, "expired");
    assert.notEqual(settled, entry);
    assert.deepEqual(entry.message?.["approval"], { requestId: "r1", status: "pending" });
    assert.equal(SLATE_AUTO_REVIEW_STALE, "auto-review/stale");
    assert.match(SLATE_AUTO_REVIEW_STALE_MESSAGE, /stale, expired, or not authorized/);
  });
});

describe("the main transcript and its threads", () => {
  const entries: Entry[] = [
    { id: "root", kind: "message" },
    { id: "a", kind: "message", replyTo: "root", branched: true },
    { id: "b", kind: "message", replyTo: "a", branched: true },
    { id: "c", kind: "notice", replyTo: "missing", branched: true },
    { id: "d", kind: "message", replyTo: "a" },
  ];

  it("leaves out what is threaded, and hands the list back as it came when nothing is", () => {
    // "c" replies to something this list does not hold, so it hangs off nothing and stays in the main transcript.
    assert.deepEqual(mainTranscriptOf(entries).map((entry) => entry.id), ["root", "c", "d"]);
    const flat: Entry[] = [{ id: "x", kind: "message" }, { id: "y", kind: "notice" }];
    assert.equal(mainTranscriptOf(flat), flat, "the same list, not a copy of it");
  });

  it("answers a thread with its root and everything hanging off it, in transcript order", () => {
    assert.deepEqual(threadOf(entries, "root").map((entry) => entry.id), ["root", "a", "b"]);
    assert.deepEqual(threadOf(entries, "a").map((entry) => entry.id), ["a", "b"]);
    assert.deepEqual(threadOf(entries, "missing"), []);
  });
});

describe("messages between agents", () => {
  it("are told apart from the user's own conversation", () => {
    assert.equal(isPeerMessage({ kind: "message", fromAgent: {} }), true);
    assert.equal(isPeerMessage({ kind: "message", toAgent: {} }), true);
    assert.equal(isPeerMessage({ kind: "message" }), false);
    assert.equal(isPeerMessage({ kind: "send-message", fromAgent: {} }), false);
    assert.equal(isPeerMessage(null), false);
  });

  it("are outbound when they are addressed to someone, and hidden when that someone is not an agent", () => {
    assert.equal(isOutboundPeerMessage({ kind: "message", toAgent: { kind: "agent" } }), true);
    assert.equal(isOutboundPeerMessage({ kind: "message", fromAgent: {} }), false);
    assert.equal(isHiddenOutboundPeerMessage({ kind: "message", toAgent: { kind: "user" } }), true);
    assert.equal(isHiddenOutboundPeerMessage({ kind: "message", toAgent: { kind: "agent" } }), false);
    assert.equal(isHiddenOutboundPeerMessage({ kind: "message" }), false);
  });

  it("do not count as the user having been active", () => {
    assert.equal(raisesUserActivity({ kind: "message", fromAgent: {} }), false);
    assert.equal(raisesUserActivity({ kind: "message" }), true);
    assert.equal(SLATE_REACTION_SELF, "me");
    assert.equal(SLATE_REACTION_AGENT, "agent");
  });
});
