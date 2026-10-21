import assert from "node:assert/strict";
import { describe, it } from "node:test";

import {
  GROUP_MAX_MEMBERS,
  LEGACY_SLATE_DEFAULT_AGENT_NAME,
  MAX_AGENTS_PER_USER,
  SLATE_AGENT_LIMIT_MESSAGE,
  SLATE_AGENT_PURPOSES,
  SLATE_DEFAULT_AGENT_NAME,
  SlateAgentLimitError,
  areAgentActivitiesEqual,
  isSlateAgentLimitError,
  isSlateAgentPurpose,
  isSlateDefaultAgentName,
  sanitizeTemplateId,
} from "../../source/shared/agents/agents.ts";

describe("the agents the platform runs for itself", () => {
  it("names them, and recognises only the names it has", () => {
    assert.deepEqual([...SLATE_AGENT_PURPOSES], ["disk-saver", "plugin-auth"]);
    assert.equal(isSlateAgentPurpose("disk-saver"), true);
    assert.equal(isSlateAgentPurpose("plugin-auth"), true);
    for (const other of ["Disk-Saver", "other", "", " disk-saver ", null, undefined, 5, {}]) assert.equal(isSlateAgentPurpose(other), false, String(other));
  });

  it("tells an agent the user made from one of them by its purpose", () => {
    const agents = [{ purpose: "disk-saver" }, { purpose: "mine" }];
    assert.deepEqual(agents.filter((agent) => isSlateAgentPurpose(agent.purpose)).length, 1);
  });
});

describe("a template id", () => {
  it("is lower case letters, digits and dashes, up to sixty-four of them", () => {
    assert.equal(sanitizeTemplateId("abc"), "abc");
    assert.equal(sanitizeTemplateId("a-1_2"), undefined, "an underscore is not a template id");
    assert.equal(sanitizeTemplateId("A"), undefined);
    assert.equal(sanitizeTemplateId("0"), "0");
    assert.equal(sanitizeTemplateId("-"), "-");
    assert.equal(sanitizeTemplateId("a".repeat(64)), "a".repeat(64));
    assert.equal(sanitizeTemplateId("a".repeat(65)), undefined);
  });

  it("answers nothing for anything that is not a text at all", () => {
    for (const other of ["", " with space", "ünïcode", null, undefined, 5, {}, ["abc"]]) assert.equal(sanitizeTemplateId(other), undefined, String(other));
  });
});

describe("two readings of what an agent is doing", () => {
  it("are the same when every field they carry is the same", () => {
    assert.equal(areAgentActivitiesEqual({ kind: "a", tool: "t" }, { kind: "a", tool: "t" }), true);
    assert.equal(areAgentActivitiesEqual({ kind: "a" }, { kind: "a", detail: "d" }), false);
    assert.equal(areAgentActivitiesEqual({ kind: "a", callId: "c" }, { kind: "a", callId: "c", target: "x" }), false);
    // Every field counts, the call id included: two readings that differ only there are two readings.
    for (const field of ["kind", "tool", "detail", "target", "callId"]) {
      assert.equal(areAgentActivitiesEqual({ [field]: "one" }, { [field]: "two" }), false, field);
    }
  });

  it("are the same when both are nothing, and different when only one is", () => {
    assert.equal(areAgentActivitiesEqual(null, null), true);
    assert.equal(areAgentActivitiesEqual(undefined, undefined), true);
    assert.equal(areAgentActivitiesEqual(null, undefined), false);
    assert.equal(areAgentActivitiesEqual(null, {}), false);
    assert.equal(areAgentActivitiesEqual({}, null), false);
  });

  it("ignore fields neither of them carries", () => {
    assert.equal(areAgentActivitiesEqual({ kind: "a", extra: 1 } as never, { kind: "a", extra: 2 } as never), true);
  });
});

describe("an agent that has not been named yet", () => {
  it("is recognised by the name it was given, and by the name the platform used before", () => {
    assert.equal(SLATE_DEFAULT_AGENT_NAME, "New Bot");
    assert.equal(LEGACY_SLATE_DEFAULT_AGENT_NAME, "New Agent");
    assert.equal(isSlateDefaultAgentName("New Bot"), true);
    assert.equal(isSlateDefaultAgentName("New Agent"), true);
  });

  it("is recognised whatever padding it arrives in, though the name itself is compared as written", () => {
    assert.equal(isSlateDefaultAgentName(" New Bot "), true);
    assert.equal(isSlateDefaultAgentName(" new bot "), false, "the padding goes and the case is compared as written");
    assert.equal(isSlateDefaultAgentName("NEW AGENT "), false, "the name is not case-folded: only the padding goes");
    assert.equal(isSlateDefaultAgentName("New  Bot"), false, "the name is compared, not the words in it");
    assert.equal(isSlateDefaultAgentName(""), false);
  });
});

describe("holding as many agents as an account may", () => {
  it("names the ceiling and the message the failure carries", () => {
    assert.equal(MAX_AGENTS_PER_USER, 50);
    assert.equal(SLATE_AGENT_LIMIT_MESSAGE, "50 is the maximum");
    assert.equal(GROUP_MAX_MEMBERS, 6);
  });

  it("raises an error that says what it is", () => {
    const error = new SlateAgentLimitError();
    assert.equal(error.name, "SlateAgentLimitError");
    assert.equal(error.message, SLATE_AGENT_LIMIT_MESSAGE);
    assert.equal(error instanceof Error, true);
  });

  it("is told apart from any other failure", () => {
    assert.equal(isSlateAgentLimitError(new SlateAgentLimitError()), true);
    assert.equal(isSlateAgentLimitError(new Error(SLATE_AGENT_LIMIT_MESSAGE)), true, "the message is what a failure from elsewhere carries");
    assert.equal(isSlateAgentLimitError(new Error("something else")), false);
    for (const other of [null, undefined, "50 is the maximum", { message: SLATE_AGENT_LIMIT_MESSAGE }]) assert.equal(isSlateAgentLimitError(other), false, String(other));
  });
});
