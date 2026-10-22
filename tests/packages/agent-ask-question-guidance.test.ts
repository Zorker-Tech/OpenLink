import assert from "node:assert/strict";
import { describe, it } from "node:test";

import {
  buildAntiAskQuestionSystemReminder,
  buildAntiAskQuestionUserRule,
} from "../../source/packages/agent/prompts/ask-question-guidance.ts";

describe("the rule that pushes the agent away from asking", () => {
  it("is written once, naming the tool wherever the rule needs it", () => {
    assert.equal(
      buildAntiAskQuestionUserRule("ask_question"),
      "ask_question tool guidance: ALWAYS use common sense and context discovery (codebase, file system, and/or web) to understand what the user is saying and predict what they want. It is ONLY in exceptional and consequential circumstances that you can use the ask_question tool after having done extensive research (or when Q&A is explicitly requested). Do NOT use the ask_question tool to ask for help, inquire into details, solicit feedback on suggestions, or ask for confirmations.",
    );
    assert.equal(buildAntiAskQuestionUserRule("ask_question").split("ask_question").length, 4, "the tool is named three times");
  });

  it("has a short reminder that names the same tool", () => {
    assert.equal(buildAntiAskQuestionSystemReminder("ask_question"), "<system_reminder>Remember the user rule about ask_question tool guidance.</system_reminder>");
  });

  it("puts whatever tool it is given into both forms", () => {
    for (const toolName of ["other_tool", "café_question", "a tool with spaces"]) {
      assert.equal(buildAntiAskQuestionUserRule(toolName).includes(toolName + " tool guidance:"), true);
      assert.equal(buildAntiAskQuestionSystemReminder(toolName).includes(toolName + " tool guidance."), true);
      assert.equal(buildAntiAskQuestionUserRule(toolName).split(toolName).length - 1, 3, toolName);
    }
    assert.equal(buildAntiAskQuestionUserRule("").startsWith(" tool guidance: ALWAYS"), true, "an empty tool name is put in as it is");
    assert.equal(buildAntiAskQuestionSystemReminder(""), "<system_reminder>Remember the user rule about  tool guidance.</system_reminder>");
  });
});