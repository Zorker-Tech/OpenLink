import assert from "node:assert/strict";
import { describe, it } from "node:test";

import {
  EMPTY_SLATE_PROFILE,
  EMPTY_UNREAD_STATE,
  REQUEST_SOURCES,
  isValidTranscriptEntry,
  parseAwaitingState,
  parseMemoryPromptSnapshot,
  parsePendingEpisodeTurns,
  parseProfile,
  parseRequestRecords,
  parseTranscriptEntry,
  parseUnreadState,
  resolveSpendGuardState,
  serializeSpendGuardState,
} from "../../source/host/extensions/session/agent-db-serde.ts";

describe("a transcript entry read back", () => {
  it("is taken when it says which kind it is and carries what that kind needs", () => {
    assert.equal(isValidTranscriptEntry({ kind: "message", content: "hello" }), true);
    assert.equal(isValidTranscriptEntry({ kind: "tool-call", name: "read" }), true);
    assert.equal(isValidTranscriptEntry({ kind: "notice", text: "note" }), true);
    assert.equal(isValidTranscriptEntry({ kind: "user-attachment", file_path: "/a" }), true);
    assert.equal(isValidTranscriptEntry({ kind: "event", event: { type: "x" } }), true);
    assert.equal(isValidTranscriptEntry({ kind: "send-message", message: { content: "hi" } }), true);
  });

  it("is refused when the kind is unknown, missing, or not a name", () => {
    for (const entry of [{}, { kind: "unknown" }, { kind: 5 }, { kind: null }, null, 5, "text", []]) {
      assert.equal(isValidTranscriptEntry(entry), false, JSON.stringify(entry));
    }
  });

  it("is refused when it lacks what its kind needs", () => {
    assert.equal(isValidTranscriptEntry({ kind: "message" }), false);
    assert.equal(isValidTranscriptEntry({ kind: "tool-call" }), false);
    assert.equal(isValidTranscriptEntry({ kind: "event", event: {} }), false);
    assert.equal(isValidTranscriptEntry({ kind: "user-attachment" }), false);
    assert.equal(isValidTranscriptEntry({ kind: "notice" }), false);
    assert.equal(isValidTranscriptEntry({ kind: "send-message", message: "not an object" }), false);
    assert.equal(isValidTranscriptEntry({ kind: "send-message" }), false);
  });

  it("checks a text message's content, and nothing else about a message that is not text", () => {
    assert.equal(isValidTranscriptEntry({ kind: "send-message", message: { type: "text", content: "hi" } }), true);
    assert.equal(isValidTranscriptEntry({ kind: "send-message", message: { type: "text", content: 5 } }), false);
    assert.equal(isValidTranscriptEntry({ kind: "send-message", message: { type: "image", content: 5 } }), true);
  });

  it("is read from its text, and an error record is refused as a kind this build does not know", () => {
    assert.deepEqual(parseTranscriptEntry('{"kind":"message","content":"hi"}'), { kind: "message", content: "hi" });
    assert.equal(parseTranscriptEntry('{"kind":"error","content":"x"}'), null);
    assert.equal(parseTranscriptEntry("not json"), null);
    assert.equal(parseTranscriptEntry("null"), null);
  });
});

describe("a profile read back", () => {
  it("keeps a description and an avatar, and answers the empty profile for nothing", () => {
    assert.deepEqual(parseProfile('{"description":"a bot","avatarPath":"/a.png"}'), { description: "a bot", avatarPath: "/a.png" });
    assert.deepEqual(parseProfile(null), EMPTY_SLATE_PROFILE);
    assert.deepEqual(parseProfile("{nope"), EMPTY_SLATE_PROFILE);
    assert.deepEqual(EMPTY_SLATE_PROFILE, { description: "", avatarPath: null });
  });

  it("reads an unwanted description as empty and an empty avatar path as none", () => {
    assert.deepEqual(parseProfile('{"description":5,"avatarPath":""}'), { description: "", avatarPath: null });
    assert.deepEqual(parseProfile('{"avatarPath":5}'), { description: "", avatarPath: null });
  });
});

describe("unread state read back", () => {
  it("keeps the numbers it can use and reads the rest as nothing", () => {
    assert.deepEqual(parseUnreadState('{"lastActivityAt":5,"lastViewedAt":9,"isManuallyUnread":true,"unreadCount":3}'), {
      lastActivityAt: 5,
      lastViewedAt: 9,
      isManuallyUnread: true,
      unreadCount: 3,
    });
    assert.deepEqual(parseUnreadState('{"lastActivityAt":"x","lastViewedAt":null,"isManuallyUnread":"yes","unreadCount":-4}'), EMPTY_UNREAD_STATE);
  });

  it("counts whole messages only, and never a negative number of them", () => {
    assert.equal(parseUnreadState('{"unreadCount":3.7}').unreadCount, 3);
    assert.equal(parseUnreadState('{"unreadCount":0.4}').unreadCount, 0);
    assert.equal(parseUnreadState('{"unreadCount":-1}').unreadCount, 0);
  });
});

describe("the spend guard read back", () => {
  it("reads a guard that was nudged, snoozed and opted out of", () => {
    assert.deepEqual(
      resolveSpendGuardState({ state: '{"nudgedAtMs":5,"snoozedUntilMs":9,"optedOut":true,"cardEntryIds":["a"],"pausedAutomationIds":["b"]}' }),
      { nudgedAtMs: 5, snoozedUntilMs: 9, optedOut: true, cardEntryIds: ["a"], pausedAutomationIds: ["b"] },
    );
  });

  it("reads the moment a record nudged before the guard had a state of its own", () => {
    assert.equal(resolveSpendGuardState({ state: null, legacyNudgedAt: 5 }).nudgedAtMs, 5);
    assert.equal(resolveSpendGuardState({ state: null, legacyNudgedAt: "7" }).nudgedAtMs, 7);
    assert.equal(resolveSpendGuardState({ state: null, legacyNudgedAt: -1 }).nudgedAtMs, null);
    assert.equal(resolveSpendGuardState({ state: null, legacyNudgedAt: "x" }).nudgedAtMs, null);
  });

  it("drops times that are not times and ids that are not ids", () => {
    const state = resolveSpendGuardState({ state: '{"nudgedAtMs":-5,"snoozedUntilMs":"x","cardEntryIds":["a",""],"pausedAutomationIds":[5,"b"]}' });
    assert.equal(state.nudgedAtMs, null);
    assert.equal(state.snoozedUntilMs, null);
    assert.deepEqual(state.cardEntryIds, ["a"]);
    assert.deepEqual(state.pausedAutomationIds, ["b"]);
  });

  it("answers a guard whose lists belong to the caller", () => {
    const first = resolveSpendGuardState({ state: null });
    first.cardEntryIds.push("leak");
    assert.deepEqual(resolveSpendGuardState({ state: null }).cardEntryIds, []);
  });

  it("is written only when there is something to remember", () => {
    assert.equal(serializeSpendGuardState({ nudgedAtMs: null, snoozedUntilMs: null, optedOut: false, cardEntryIds: [], pausedAutomationIds: [] }), null);
    assert.equal(serializeSpendGuardState({ nudgedAtMs: 5, snoozedUntilMs: null, optedOut: false, cardEntryIds: [], pausedAutomationIds: [] }), '{"nudgedAtMs":5,"snoozedUntilMs":null,"optedOut":false,"cardEntryIds":[],"pausedAutomationIds":[]}');
    assert.equal(serializeSpendGuardState({ nudgedAtMs: null, snoozedUntilMs: null, optedOut: true, cardEntryIds: [], pausedAutomationIds: [] })?.includes('"optedOut":true'), true);
  });
});

describe("the tab a session is waiting on", () => {
  it("is read with its reason and the moment it started", () => {
    assert.deepEqual(parseAwaitingState('{"tabId":"t1","reason":"sign in","since":5}'), { tabId: "t1", reason: "sign in", since: 5 });
  });

  it("is nothing when no tab is named, and reads what is missing as nothing", () => {
    assert.equal(parseAwaitingState('{"tabId":""}'), null);
    assert.equal(parseAwaitingState("{}"), null);
    assert.equal(parseAwaitingState(null), null);
    assert.deepEqual(parseAwaitingState('{"tabId":"t1"}'), { tabId: "t1", reason: "", since: 0 });
  });
});

describe("the requests an agent has been asked", () => {
  it("are read oldest first, with the prompt and the source that were given", () => {
    assert.deepEqual(parseRequestRecords('[{"id":" a ","at":5,"prompt":"do it","source":"turn"}]'), [{ id: "a", at: 5, prompt: "do it", source: "turn" }]);
  });

  it("drops a record with no id, and reads what is missing as nothing", () => {
    assert.deepEqual(parseRequestRecords('[{"id":"  "},{"id":"b","at":-1,"prompt":"","source":"nope"}]'), [{ id: "b", at: 0 }]);
    assert.deepEqual(parseRequestRecords("not a list"), []);
    assert.deepEqual(parseRequestRecords("[null,5]"), []);
  });

  it("takes a source only when it is one this build knows", () => {
    assert.equal(REQUEST_SOURCES.size, 9);
    assert.deepEqual(parseRequestRecords(`[{"id":"c","source":"web-search"}]`), [{ id: "c", at: 0, source: "web-search" }]);
    assert.deepEqual(parseRequestRecords(`[{"id":"c","source":"made-up"}]`), [{ id: "c", at: 0 }]);
  });
});

describe("the prompt snapshot a memory render came from", () => {
  it("needs both of its parts, or it is nothing", () => {
    assert.deepEqual(parseMemoryPromptSnapshot('{"render":"r","compactionEpoch":3}'), { render: "r", compactionEpoch: 3 });
    assert.equal(parseMemoryPromptSnapshot('{"render":"r"}'), null);
    assert.equal(parseMemoryPromptSnapshot('{"render":5,"compactionEpoch":3}'), null);
    assert.equal(parseMemoryPromptSnapshot('{"render":"r","compactionEpoch":"3"}'), null);
    assert.equal(parseMemoryPromptSnapshot(null), null);
  });
});

describe("the turns an episode has collected", () => {
  it("are read with their moment and both sides", () => {
    assert.deepEqual(parsePendingEpisodeTurns('[{"ts":1,"user":"u","agent":"a"},{"ts":2,"user":"only user"}]'), [
      { ts: 1, user: "u", agent: "a" },
      { ts: 2, user: "only user", agent: "" },
    ]);
  });

  it("leave out a turn with neither side said, and read a missing moment as nothing", () => {
    assert.deepEqual(parsePendingEpisodeTurns('[{"user":"","agent":""},{"user":"u"}]'), [{ ts: 0, user: "u", agent: "" }]);
    assert.deepEqual(parsePendingEpisodeTurns("[null,5]"), []);
    assert.deepEqual(parsePendingEpisodeTurns(null), []);
  });
});
