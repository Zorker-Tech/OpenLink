import assert from "node:assert/strict";
import { describe, it } from "node:test";

import {
  INTRODUCTION_FAILED_TRAY_TITLE,
  SLATE_ONBOARDING_KICKSTART_PROMPT,
  introductionFailedTrayKey,
} from "../../source/shared/agents/onboarding.ts";

describe("an agent's first-run cue", () => {
  it("is one prompt of six non-empty paragraphs, joined by a single newline each", () => {
    const paragraphs = SLATE_ONBOARDING_KICKSTART_PROMPT.split("\n");
    assert.equal(paragraphs.length, 6);
    for (const paragraph of paragraphs) assert.equal(paragraph.trim().length > 0, true, paragraph.slice(0, 30));
    assert.equal(SLATE_ONBOARDING_KICKSTART_PROMPT.includes("\n\n"), false);
  });

  it("opens by saying what the turn is: a first run, not a message to answer", () => {
    assert.equal(SLATE_ONBOARDING_KICKSTART_PROMPT.startsWith("[first run]"), true);
    assert.match(SLATE_ONBOARDING_KICKSTART_PROMPT, /not a message to reply to/);
  });

  it("tells the agent where its words can reach the user and how a choice is offered", () => {
    assert.match(SLATE_ONBOARDING_KICKSTART_PROMPT, /Nothing reaches the user unless it's inside a SendMessage/);
    assert.match(SLATE_ONBOARDING_KICKSTART_PROMPT, /question widget/);
    assert.match(SLATE_ONBOARDING_KICKSTART_PROMPT, /connector card/);
  });

  it("keeps the profile's assignment ahead of the getting-started questions", () => {
    const paragraphs = SLATE_ONBOARDING_KICKSTART_PROMPT.split("\n");
    assert.match(paragraphs[2]!, /If your profile description gives you a concrete assignment/);
    assert.match(paragraphs[3]!, /Run getting-started as a real conversation/);
  });

  it("does not name the cue or its instructions as setup the agent was given", () => {
    assert.match(SLATE_ONBOARDING_KICKSTART_PROMPT, /Don't mention this cue or that you were given setup instructions/);
  });
});

describe("an agent whose introduction failed", () => {
  it("has a tray title that says what happened", () => {
    assert.equal(INTRODUCTION_FAILED_TRAY_TITLE, "Your agent couldn't introduce itself");
  });

  it("is remembered under a key of its own, per agent", () => {
    assert.equal(introductionFailedTrayKey("agent-1"), "introduction-failed:agent-1");
    assert.equal(introductionFailedTrayKey(""), "introduction-failed:");
    assert.equal(introductionFailedTrayKey("ünïcode 🌱"), "introduction-failed:ünïcode 🌱");
    assert.notEqual(introductionFailedTrayKey("a"), introductionFailedTrayKey("b"));
  });
});
