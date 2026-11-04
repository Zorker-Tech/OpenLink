/** Turns current session observations into reasons to rebuild the conversation's first user-info block. */

import {
  getFirstUserInfoOmitCloudWorkerProcedure,
  getFirstUserInfoRequestContextCompleteness,
  getFirstUserInfoSummarizationEpoch,
  type PriorUserInfoMessage,
} from "../../prompts/user-info-preparation.ts"
import {
  getRequestContextCompleteness,
  shouldRerenderUserInfoAfterSummarization,
  shouldRerenderUserInfoForRequestContextRecovery,
} from "../../prompts/user-info-rerender.ts"
import { shouldRerenderUserInfo } from "../../prompts/user-info-preparation.ts"
import { shouldRebuildUserInfoForPullRequestRule } from "../../../utils/pull-request-guidance.ts"
import { planUserInfoRefresh, type UserInfoRefreshPlan } from "./user-info-refresh-plan.ts"

type PriorMessages = readonly PriorUserInfoMessage[]
type ContextCompleteness = ReturnType<typeof getRequestContextCompleteness>
type UserInfoRuleOptions = Parameters<typeof shouldRerenderUserInfo>[6]

export interface UserInfoRefreshEvaluationInput {
  readonly priorMessages: PriorMessages
  readonly hasExistingNonSystemMessages: boolean
  readonly expectedCustomUserRules: readonly string[]
  readonly modelInfo: unknown
  readonly agentTypeChanged: boolean
  readonly featureFlags: Readonly<Record<string, unknown>> | undefined
  readonly ruleOptions: UserInfoRuleOptions
  readonly currentRequestContextCompleteness: ContextCompleteness
  readonly currentSummarizationEpoch: number
  readonly omitCloudWorkerProcedure: boolean
  readonly firstUserInfoContent: string | undefined
  readonly localPullRequestGuidance: string | undefined
  readonly reminderMigrationNeeded: boolean
  readonly cloudTestingPlacementRecoveryNeeded: boolean
  readonly displayEnabled: boolean
  readonly importedHistoryReplacesUserInfo: boolean
  readonly isMultitaskTurn: boolean
  readonly isFirstConversationTurn: boolean
  readonly userInfoAlreadyHasReminder: boolean
}

export function evaluateUserInfoRefresh(input: UserInfoRefreshEvaluationInput): UserInfoRefreshPlan {
  const previouslyCapturedCompleteness = getFirstUserInfoRequestContextCompleteness(input.priorMessages)
  const previouslyCapturedEpoch = getFirstUserInfoSummarizationEpoch(input.priorMessages)
  const firstUserInfo = input.firstUserInfoContent

  const signals = [
    {
      reason: "agent_type_or_composer_rules_change",
      active: shouldRerenderUserInfo(
        input.hasExistingNonSystemMessages,
        input.priorMessages,
        input.expectedCustomUserRules,
        input.modelInfo,
        input.agentTypeChanged,
        input.featureFlags,
        input.ruleOptions,
      ),
    },
    {
      reason: "request_context_recovery",
      active: input.featureFlags?.rerenderUserInfoOnRequestContextRecovery === true &&
        shouldRerenderUserInfoForRequestContextRecovery({
          previousCompleteness: previouslyCapturedCompleteness,
          currentCompleteness: input.currentRequestContextCompleteness,
        }),
    },
    {
      reason: "summarization_epoch_advanced",
      active: input.featureFlags?.rerenderUserInfoOnSummarization === true &&
        shouldRerenderUserInfoAfterSummarization({
          previousEpoch: previouslyCapturedEpoch,
          currentEpoch: input.currentSummarizationEpoch,
        }),
    },
    {
      reason: "omit_cloud_worker_procedure_change",
      active: input.hasExistingNonSystemMessages && firstUserInfo !== undefined &&
        getFirstUserInfoOmitCloudWorkerProcedure(input.priorMessages) !== input.omitCloudWorkerProcedure,
    },
    {
      reason: "local_pr_creation_guidance_changed",
      active: input.hasExistingNonSystemMessages && firstUserInfo !== undefined &&
        shouldRebuildUserInfoForPullRequestRule({
          renderedUserInfo: firstUserInfo,
          ...(input.localPullRequestGuidance !== undefined
            ? { selectedRule: input.localPullRequestGuidance }
            : {}),
        }),
    },
    { reason: "multitask_reminder_migration", active: input.reminderMigrationNeeded },
    { reason: "cloud_testing_placement_recovery", active: input.cloudTestingPlacementRecoveryNeeded },
  ] as const

  return planUserInfoRefresh({
    hasExistingNonSystemMessages: input.hasExistingNonSystemMessages,
    displayEnabled: input.displayEnabled,
    importedHistoryReplacesUserInfo: input.importedHistoryReplacesUserInfo,
    signals,
    isMultitaskTurn: input.isMultitaskTurn,
    isFirstConversationTurn: input.isFirstConversationTurn,
    userInfoAlreadyHasReminder: input.userInfoAlreadyHasReminder,
    reminderMigrationNeeded: input.reminderMigrationNeeded,
  })
}
