import { test } from "node:test"
import assert from "node:assert/strict"

import {
  evaluateUserInfoRefresh,
  type UserInfoRefreshEvaluationInput,
} from "../../source/packages/agent/actions/user-message-action/user-info-refresh-evaluation.ts"
import { planUserInfoRefresh } from "../../source/packages/agent/actions/user-message-action/user-info-refresh-plan.ts"
import { getRequestContextCompleteness } from "../../source/packages/agent/prompts/user-info-rerender.ts"
import { shouldMigrateMultitaskEnterReminderToUserInfo, type PriorUserInfoMessage } from "../../source/packages/agent/prompts/user-info-preparation.ts"
import { toRedactedCoreMessages } from "../../source/packages/redaction/message-redaction.ts"
import { PrivacyMode } from "../../source/packages/redaction/privacy-mode.ts"

const input = {
  hasExistingNonSystemMessages: true,
  displayEnabled: true,
  importedHistoryReplacesUserInfo: false,
  signals: [],
  isMultitaskTurn: false,
  isFirstConversationTurn: false,
  userInfoAlreadyHasReminder: false,
  reminderMigrationNeeded: false,
}

const USER_INFO = "<user_info>stable context</user_info>"

function priorUserInfo(
  metadata: Readonly<Record<string, unknown>> = {},
): readonly PriorUserInfoMessage[] {
  const [message] = toRedactedCoreMessages([
    { role: "user", content: [{ type: "text", text: USER_INFO }] },
  ], PrivacyMode.UNSPECIFIED)
  return [{
    ...message!,
    providerOptions: { slate: metadata },
  }] as unknown as readonly PriorUserInfoMessage[]
}

function evaluationInput(overrides: Partial<UserInfoRefreshEvaluationInput> = {}) {
  return {
    priorMessages: priorUserInfo(),
    hasExistingNonSystemMessages: true,
    expectedCustomUserRules: [],
    modelInfo: undefined,
    agentTypeChanged: false,
    featureFlags: undefined,
    ruleOptions: { skipDynamicToolSnapshotCheck: true },
    currentRequestContextCompleteness: getRequestContextCompleteness({}),
    currentSummarizationEpoch: 0,
    omitCloudWorkerProcedure: false,
    firstUserInfoContent: USER_INFO,
    localPullRequestGuidance: undefined,
    reminderMigrationNeeded: false,
    cloudTestingPlacementRecoveryNeeded: false,
    displayEnabled: true,
    importedHistoryReplacesUserInfo: false,
    isMultitaskTurn: false,
    isFirstConversationTurn: false,
    userInfoAlreadyHasReminder: false,
    ...overrides,
  }
}

test("freshness evaluation reuses a stable block and names the changed guidance that invalidates it", () => {
  assert.deepEqual(evaluateUserInfoRefresh(evaluationInput()), {
    shouldRender: false,
    replacesExistingBlock: false,
    shouldAppendMultitaskReminder: false,
    reasons: [],
  })
  assert.deepEqual(evaluateUserInfoRefresh(evaluationInput({ localPullRequestGuidance: "Use the configured forge" })), {
    shouldRender: true,
    replacesExistingBlock: true,
    shouldAppendMultitaskReminder: false,
    reasons: ["local_pr_creation_guidance_changed"],
  })
})

test("freshness evaluation responds to recovered context and an advanced summary epoch only when enabled", () => {
  const complete = getRequestContextCompleteness({})
  const incomplete = { ...complete, env: false }
  const withOldCompleteness = priorUserInfo({ requestContextCompleteness: incomplete })
  assert.equal(evaluateUserInfoRefresh(evaluationInput({
    priorMessages: withOldCompleteness,
    featureFlags: { rerenderUserInfoOnRequestContextRecovery: true },
    currentRequestContextCompleteness: complete,
  })).replacesExistingBlock, true)

  const withOldEpoch = priorUserInfo({ userInfoSummarizationEpoch: 2 })
  const afterSummary = evaluateUserInfoRefresh(evaluationInput({
    priorMessages: withOldEpoch,
    featureFlags: { rerenderUserInfoOnSummarization: true },
    currentSummarizationEpoch: 3,
  }))
  assert.deepEqual(afterSummary.reasons, ["summarization_epoch_advanced"])
  assert.equal(evaluateUserInfoRefresh(evaluationInput({
    priorMessages: withOldEpoch,
    currentSummarizationEpoch: 3,
  })).shouldRender, false)
})

test("a missing block is added, while an unchanged existing block is reused", () => {
  assert.deepEqual(planUserInfoRefresh({ ...input, hasExistingNonSystemMessages: false }), {
    shouldRender: true,
    replacesExistingBlock: false,
    shouldAppendMultitaskReminder: false,
    reasons: [],
  })
  assert.deepEqual(planUserInfoRefresh(input), {
    shouldRender: false,
    replacesExistingBlock: false,
    shouldAppendMultitaskReminder: false,
    reasons: [],
  })
})

test("every active refresh signal is returned and replaces the prior block", () => {
  assert.deepEqual(planUserInfoRefresh({
    ...input,
    signals: [
      { reason: "rules_changed", active: true },
      { reason: "summary_advanced", active: false },
      { reason: "context_recovered", active: true },
    ],
  }), {
    shouldRender: true,
    replacesExistingBlock: true,
    shouldAppendMultitaskReminder: false,
    reasons: ["rules_changed", "context_recovered"],
  })
})

test("new local pull-request guidance refreshes an existing user-info block", () => {
  assert.deepEqual(planUserInfoRefresh({
    ...input,
    signals: [{ reason: "local_pr_creation_guidance_changed", active: true }],
  }), {
    shouldRender: true,
    replacesExistingBlock: true,
    shouldAppendMultitaskReminder: false,
    reasons: ["local_pr_creation_guidance_changed"],
  })
})

test("disabled display and imported history take precedence over refresh signals", () => {
  const changed = { ...input, signals: [{ reason: "rules_changed", active: true }] }
  assert.equal(planUserInfoRefresh({ ...changed, displayEnabled: false }).shouldRender, false)
  assert.equal(planUserInfoRefresh({ ...changed, importedHistoryReplacesUserInfo: true }).shouldRender, false)
})

test("a multitask reminder is added for a first turn or carried through an existing block", () => {
  assert.equal(planUserInfoRefresh({
    ...input,
    hasExistingNonSystemMessages: false,
    isMultitaskTurn: true,
    isFirstConversationTurn: true,
  }).shouldAppendMultitaskReminder, true)
  const refreshing = { ...input, signals: [{ reason: "refresh", active: true }], isMultitaskTurn: true }
  assert.equal(planUserInfoRefresh({ ...refreshing, userInfoAlreadyHasReminder: true }).shouldAppendMultitaskReminder, true)
  assert.equal(planUserInfoRefresh({ ...refreshing, reminderMigrationNeeded: true }).shouldAppendMultitaskReminder, true)
  assert.equal(planUserInfoRefresh({ ...input, isMultitaskTurn: true }).shouldAppendMultitaskReminder, false)
})

test("a reminder migrates only across a summarized multitask turn whose block lacks it", () => {
  const base = {
    hasExistingNonSystemMessages: true,
    previousTurnWasMultitask: true,
    resolvedTurnIsMultitask: true,
    priorMessages: priorUserInfo({ isSummary: true }),
    firstUserInfoContent: USER_INFO,
    userInfoAlreadyHasMultitaskEnterReminder: false,
  }
  assert.equal(shouldMigrateMultitaskEnterReminderToUserInfo(base), true)
  assert.equal(shouldMigrateMultitaskEnterReminderToUserInfo({ ...base, previousTurnWasMultitask: false }), false)
  assert.equal(shouldMigrateMultitaskEnterReminderToUserInfo({ ...base, resolvedTurnIsMultitask: false }), false)
  assert.equal(shouldMigrateMultitaskEnterReminderToUserInfo({ ...base, priorMessages: priorUserInfo() }), false)
  assert.equal(shouldMigrateMultitaskEnterReminderToUserInfo({ ...base, firstUserInfoContent: undefined }), false)
  assert.equal(shouldMigrateMultitaskEnterReminderToUserInfo({ ...base, userInfoAlreadyHasMultitaskEnterReminder: true }), false)
})
