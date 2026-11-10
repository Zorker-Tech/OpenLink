import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { normalizeAgentConfig } from "../../source/packages/agent/agent-config-runtime.ts";
import { MAX_AGENT_STEPS } from "../../source/packages/agent/constants.ts";
import { DISABLED_BACKGROUND_SUMMARIZATION_PROPS } from "../../source/packages/agent-summarization/background-summarization.ts";

describe("normalized agent configuration", () => {
  it("fills every absent runtime setting with a stable default", () => {
    const systemPromptGenerator = () => "prompt";
    const config = normalizeAgentConfig({ systemPromptGenerator });

    assert.equal(config.systemPromptGenerator, systemPromptGenerator);
    assert.equal(config.maxSteps, MAX_AGENT_STEPS);
    assert.equal(config.backgroundSummarizationProps, DISABLED_BACKGROUND_SUMMARIZATION_PROPS);
    assert.deepEqual(config.formattingOptions, {
      shouldUseFormatCodeblock: true,
      gpt5StyleLineNumbers: false,
      gpt5CodexCatN: false,
    });
    assert.deepEqual({
      immediatelyUpdateStateOnNewTurn: config.immediatelyUpdateStateOnNewTurn,
      smartModeClassifierMode: config.smartModeClassifierMode,
      smartModeClassifierShadowMode: config.smartModeClassifierShadowMode,
      doNotFailOnMaxSteps: config.doNotFailOnMaxSteps,
      enableAgentNotes: config.enableAgentNotes,
      enableTerminalFiles: config.enableTerminalFiles,
      enableImageFiles: config.enableImageFiles,
      enableLongCodeSelectionSpillToFile: config.enableLongCodeSelectionSpillToFile,
      enableToolArgPreservation: config.enableToolArgPreservation,
      strictArgParsing: config.strictArgParsing,
      enableExecuteHookExec: config.enableExecuteHookExec,
      enableTranscriptInSummary: config.enableTranscriptInSummary,
      summarizeActionClearTurns: config.summarizeActionClearTurns,
      fireAndForgetCheckpoints: config.fireAndForgetCheckpoints,
      skipErrorStateCheckpoint: config.skipErrorStateCheckpoint,
      enablePrependedUserActions: config.enablePrependedUserActions,
    }, {
      immediatelyUpdateStateOnNewTurn: false,
      smartModeClassifierMode: false,
      smartModeClassifierShadowMode: false,
      doNotFailOnMaxSteps: false,
      enableAgentNotes: false,
      enableTerminalFiles: true,
      enableImageFiles: false,
      enableLongCodeSelectionSpillToFile: true,
      enableToolArgPreservation: true,
      strictArgParsing: false,
      enableExecuteHookExec: false,
      enableTranscriptInSummary: true,
      summarizeActionClearTurns: false,
      fireAndForgetCheckpoints: false,
      skipErrorStateCheckpoint: false,
      enablePrependedUserActions: true,
    });
    assert.deepEqual(config.nonFileRules, []);
    assert.equal(config.planSystemReminderGenerator(), "");
    assert.equal(config.askSystemReminderGenerator({}), "");
    assert.equal(config.debugSystemReminderGenerator(undefined, true), "");
    assert.equal(config.triageSystemReminderGenerator(), "");
    assert.equal(config.projectSystemReminderGenerator(), "");
  });

  it("keeps caller values, treats zero as a step limit, and defaults a null limit", () => {
    const promptGenerator = () => "custom";
    const formattingOptions = { shouldUseFormatCodeblock: false };
    const featureFlags = { enableAgentStoreConflictNotices: true };
    const config = normalizeAgentConfig({
      systemPromptGenerator: promptGenerator,
      maxSteps: 0,
      enableAgentNotes: true,
      formattingOptions,
      featureFlags,
    });

    assert.equal(config.systemPromptGenerator, promptGenerator);
    assert.equal(config.maxSteps, 0);
    assert.equal(config.enableAgentNotes, true);
    assert.equal(config.formattingOptions, formattingOptions);
    assert.equal(config.featureFlags, featureFlags);
    assert.equal(normalizeAgentConfig({ systemPromptGenerator: promptGenerator, maxSteps: null }).maxSteps, MAX_AGENT_STEPS);
    assert.throws(() => normalizeAgentConfig({}), /systemPromptGenerator is required/);
  });

  it("filters non-file rules by normalized actor email without mutating the supplied list", () => {
    const rules = [
      { fullPath: "/rules/current", content: "current", scopedTo: [" PERSON@EXAMPLE.TEST "] },
      { fullPath: "/rules/other", content: "other", scopedTo: ["someone@example.test"] },
      { fullPath: "/rules/shared", content: "shared" },
    ];
    const config = normalizeAgentConfig({
      systemPromptGenerator: () => "prompt",
      actorIdentity: { email: "person@example.test" },
      nonFileRules: rules,
    });

    assert.deepEqual(config.nonFileRules.map((rule: { fullPath: string }) => rule.fullPath), ["/rules/current", "/rules/shared"]);
    assert.equal(rules.length, 3);
  });
});
