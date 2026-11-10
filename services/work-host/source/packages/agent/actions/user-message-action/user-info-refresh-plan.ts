/** Decisions for refreshing the first user-info block and carrying a multitask reminder into it. */

export interface UserInfoRefreshSignal {
  readonly reason: string
  readonly active: boolean
}

export interface UserInfoRefreshPlanInput {
  readonly hasExistingNonSystemMessages: boolean
  readonly displayEnabled: boolean
  readonly importedHistoryReplacesUserInfo: boolean
  readonly signals: readonly UserInfoRefreshSignal[]
  readonly isMultitaskTurn: boolean
  readonly isFirstConversationTurn: boolean
  readonly userInfoAlreadyHasReminder: boolean
  readonly reminderMigrationNeeded: boolean
}

export interface UserInfoRefreshPlan {
  readonly shouldRender: boolean
  readonly replacesExistingBlock: boolean
  readonly shouldAppendMultitaskReminder: boolean
  readonly reasons: readonly string[]
}

export function planUserInfoRefresh(input: UserInfoRefreshPlanInput): UserInfoRefreshPlan {
  const reasons = input.signals.filter(signal => signal.active).map(signal => signal.reason)
  const shouldRender = input.displayEnabled && !input.importedHistoryReplacesUserInfo &&
    (!input.hasExistingNonSystemMessages || reasons.length > 0)
  return {
    shouldRender,
    replacesExistingBlock: shouldRender && input.hasExistingNonSystemMessages,
    shouldAppendMultitaskReminder: shouldRender && input.isMultitaskTurn && (
      !input.hasExistingNonSystemMessages && input.isFirstConversationTurn ||
      input.userInfoAlreadyHasReminder || input.reminderMigrationNeeded
    ),
    reasons,
  }
}
