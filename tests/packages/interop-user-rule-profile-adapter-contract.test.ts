import { test } from "node:test"
import assert from "node:assert/strict"

import { adaptInteropUserRuleProfile, getGeneratedUserRulesForModel } from "../../source/adapters/interop/agent/user-rule-profile-adapter.ts"

test("the adapter suppresses guidance for a raw training tag", () => {
  assert.deepEqual(adaptInteropUserRuleProfile(
    { isComposerMatterhorn: true, isRawTrainingSlug: true },
    { enableComposer2CustomUserRules: true, enableTahomaUserRuleIntervention: true },
  ), {
    ruleSet: "suppressed",
    includeFinalResponseGuidance: false,
    includeInterfaceGuidance: false,
    preventBroadGlobSearch: false,
  })
})

test("model and feature records resolve to a Slate-owned rule profile", () => {
  assert.deepEqual(adaptInteropUserRuleProfile(
    { isComposerMatterhorn: true },
    {
      enableComposer2CustomUserRules: true,
      enableMatterhornPromptTweaks: true,
      enableGrepBroadGlobGuard: true,
      enableTahomaUserRuleIntervention: true,
      enableVegaFrontendUserRuleIntervention: true,
    },
    { shellToolName: "Run", awaitToolName: "Wait", grepToolName: "Search" },
  ), {
    ruleSet: "tool-aware",
    includeFinalResponseGuidance: true,
    includeInterfaceGuidance: true,
    preventBroadGlobSearch: true,
    shellToolName: "Run",
    awaitToolName: "Wait",
    grepToolName: "Search",
  })
})

test("tool-aware options are omitted when their matching behavior is disabled", () => {
  assert.deepEqual(adaptInteropUserRuleProfile(
    {},
    { enableComposer2CustomUserRules: true, enableMatterhornPromptTweaks: true },
    { shellToolName: "", awaitToolName: "Wait", grepToolName: "Search" },
  ), {
    ruleSet: "general",
    includeFinalResponseGuidance: false,
    includeInterfaceGuidance: false,
    preventBroadGlobSearch: false,
  })
})

test("generated guidance keeps its order and tool names after adaptation", () => {
  const rules = getGeneratedUserRulesForModel(
    { isComposerMatterhorn: true },
    { enableComposer2CustomUserRules: true, enableMatterhornPromptTweaks: true },
    { shellToolName: "Run", awaitToolName: "Wait" },
  )
  assert.match(rules[0] ?? "", /Treat the user's request/)
  assert.equal(rules.some(rule => rule.startsWith("When using Run,")), true)
  assert.equal(rules.some(rule => rule.startsWith("When waiting on Wait")), true)
})
