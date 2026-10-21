import assert from "node:assert/strict";
import { describe, it } from "node:test";

import {
  ACTION_VERB,
  WAKE_CUE,
  buildTimelineEventWakePrompt,
  describeEvent,
  unknownEventText,
  type TimelineEvent,
} from "../../source/shared/slate-timeline-events.ts";

describe("what a timeline event says happened", () => {
  it("says each kind in one sentence", () => {
    assert.equal(describeEvent({ type: "name-changed", to: "Bot" }), "Renamed to Bot");
    assert.equal(describeEvent({ type: "channel-connected", label: "Slack" }), "Connected to Slack");
    assert.equal(describeEvent({ type: "channel-disconnected", label: "Slack" }), "Disconnected from Slack");
  });

  it("says what an automation's action was, with the verb that action is said with", () => {
    assert.deepEqual(ACTION_VERB, { created: "Created", updated: "Updated", enabled: "Enabled", disabled: "Disabled", deleted: "Deleted" });
    for (const [action, verb] of Object.entries(ACTION_VERB)) {
      assert.equal(describeEvent({ type: "automation-changed", action, automationName: "Daily" }), `${verb} automation "Daily"`);
    }
    assert.equal(describeEvent({ type: "automation-changed", action: "made-up", automationName: "Daily" }), 'Changed automation "Daily"');
  });

  it("says the fallback for an event it does not describe", () => {
    assert.equal(describeEvent({ type: "something-new" }), "Updated this conversation");
    assert.equal(unknownEventText({ type: "x" }, "otherwise"), "otherwise");
  });

  it("does not answer with a describer for a name every object already has", () => {
    for (const type of ["toString", "__proto__", "constructor", "hasOwnProperty", "valueOf"]) {
      assert.equal(describeEvent({ type }), "Updated this conversation", type);
    }
  });
});

describe("the prompt a timeline event wakes with", () => {
  it("says what the cue means, one line per event, and what to do about it", () => {
    const events: TimelineEvent[] = [{ type: "name-changed", to: "Bot" }, { type: "channel-connected", label: "Slack" }];
    const prompt = buildTimelineEventWakePrompt(events);
    assert.equal(WAKE_CUE, "[event]");
    const lines = prompt.split("\n");
    assert.equal(lines[0], "[event] Something about this conversation just changed.");
    assert.match(lines[1] ?? "", /not the user typing in this app/);
    assert.deepEqual(lines.slice(2, 4), ["- Renamed to Bot", "- Connected to Slack"]);
    assert.match(lines.at(-1) ?? "", /reply with SendMessage/);
  });

  it("carries no event lines when there is nothing to say", () => {
    const lines = buildTimelineEventWakePrompt([]).split("\n");
    assert.equal(lines.length, 3, "the cue, what it means, and what to do about it");
    assert.equal(lines.some((line) => line.startsWith("- ")), false);
  });
});
