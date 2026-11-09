/**
 * The same updates, carrying redacted values.
 *
 * A client can be a renderer that is allowed to show text, or a mirror that is not — so the update
 * builders come in two flavours, and this is the second one: the text-bearing fields arrive as
 * `RedactedString`s, and the privacy mode travels with each update so a reader can tell which mode the
 * value was redacted under. The builders take the mode from the value they are given wherever they
 * can, because a redacted string already knows its own mode and a caller should not have to repeat it.
 */

import type { PrivacyMode } from "../../../packages/redaction/privacy-mode.ts"
import type { RedactedString } from "../../../packages/redaction/redacted-values.ts"
import type { SlateUserMessage } from "../../../packages/agent/user-message-state.ts"
import {
  slateUserMessageAppendedUpdate,
  slateUserMessageUpdateCarrier,
  unredactSlateUserMessage,
} from "./user-message-action-protocol-adapter.ts"

export { slateUserMessageAppendedUpdate, unredactSlateUserMessage }

interface RedactedCarrier {
  readonly _privacyMode: PrivacyMode
  readonly [key: string]: unknown
}

interface RedactedInteractionUpdate {
  readonly _privacyMode: PrivacyMode
  readonly message: {
    readonly case: string
    readonly value: RedactedCarrier
  }
}

export interface ContextInjectionState {
  readonly kind: "queued" | "delivered" | "queued_for_next_turn" | "cancelled" | "rejected"
  readonly step?: unknown
  readonly deliveryBatchId?: unknown
  readonly deliveredAtMs?: string | number | bigint
  readonly reason?: unknown
}

function toRedactedContextInjectionStateValue(
  privacyMode: PrivacyMode,
  state: ContextInjectionState,
): RedactedCarrier {
  switch (state.kind) {
    case "queued":
      return { _privacyMode: privacyMode, state: { case: "queued", value: { _privacyMode: privacyMode } } }
    case "delivered":
      return {
        _privacyMode: privacyMode,
        state: {
          case: "delivered",
          value: {
            _privacyMode: privacyMode,
            step: state.step,
            deliveryBatchId: state.deliveryBatchId,
            deliveredAtMs: BigInt(state.deliveredAtMs as string | number | bigint),
          },
        },
      }
    case "queued_for_next_turn":
      return { _privacyMode: privacyMode, state: { case: "queuedForNextTurn", value: { _privacyMode: privacyMode } } }
    case "cancelled":
      return { _privacyMode: privacyMode, state: { case: "cancelled", value: { _privacyMode: privacyMode } } }
    case "rejected":
      return {
        _privacyMode: privacyMode,
        state: { case: "rejected", value: { _privacyMode: privacyMode, reason: state.reason } },
      }
  }
}

export interface RedactedFeedbackCategory {
  readonly id: unknown
  readonly label: unknown
}

export interface RedactedFeedbackCategoryGroup {
  readonly id: unknown
  readonly prompt: unknown
  readonly categories: readonly RedactedFeedbackCategory[]
}

export const RedactedUpdates = {
  toolCallStarted(callId: string, toolCall: RedactedCarrier, modelCallId: unknown): RedactedInteractionUpdate {
    const privacyMode = toolCall._privacyMode
    return {
      _privacyMode: privacyMode,
      message: { case: "toolCallStarted", value: { _privacyMode: privacyMode, callId, toolCall, modelCallId } },
    }
  },
  toolCallCompleted(callId: string, toolCall: RedactedCarrier, modelCallId: unknown): RedactedInteractionUpdate {
    const privacyMode = toolCall._privacyMode
    return {
      _privacyMode: privacyMode,
      message: { case: "toolCallCompleted", value: { _privacyMode: privacyMode, callId, toolCall, modelCallId } },
    }
  },
  toolCallDelta(callId: string, toolCallDelta: RedactedCarrier, modelCallId: unknown): RedactedInteractionUpdate {
    const privacyMode = toolCallDelta._privacyMode
    return {
      _privacyMode: privacyMode,
      message: { case: "toolCallDelta", value: { _privacyMode: privacyMode, callId, toolCallDelta, modelCallId } },
    }
  },
  userMessageAppended(userMessage: RedactedCarrier): RedactedInteractionUpdate {
    const privacyMode = userMessage._privacyMode
    return {
      _privacyMode: privacyMode,
      message: { case: "userMessageAppended", value: { _privacyMode: privacyMode, userMessage } },
    }
  },
  slateUserMessageAppended(userMessage: SlateUserMessage, privacyMode: PrivacyMode): RedactedInteractionUpdate {
    return RedactedUpdates.userMessageAppended(slateUserMessageUpdateCarrier(userMessage, privacyMode) as RedactedCarrier)
  },
  partialToolCall(
    callId: string,
    toolCall: RedactedCarrier,
    modelCallId: unknown,
    argsTextDelta: unknown,
  ): RedactedInteractionUpdate {
    const privacyMode = toolCall._privacyMode
    return {
      _privacyMode: privacyMode,
      message: {
        case: "partialToolCall",
        value: { _privacyMode: privacyMode, callId, toolCall, modelCallId, argsTextDelta },
      },
    }
  },
  summary(summary: RedactedString): RedactedInteractionUpdate {
    const privacyMode = summary.__privacyMode
    return {
      _privacyMode: privacyMode,
      message: { case: "summary", value: { _privacyMode: privacyMode, summary } },
    }
  },
  summaryStarted(privacyMode: PrivacyMode): RedactedInteractionUpdate {
    return { _privacyMode: privacyMode, message: { case: "summaryStarted", value: { _privacyMode: privacyMode } } }
  },
  contextInjectionState(
    privacyMode: PrivacyMode,
    injectionId: string,
    state: ContextInjectionState,
  ): RedactedInteractionUpdate {
    return {
      _privacyMode: privacyMode,
      message: {
        case: "contextInjectionState",
        value: {
          _privacyMode: privacyMode,
          injectionId,
          state: toRedactedContextInjectionStateValue(privacyMode, state),
        },
      },
    }
  },
  summaryCompleted(privacyMode: PrivacyMode, hookMessage: unknown): RedactedInteractionUpdate {
    return {
      _privacyMode: privacyMode,
      message: { case: "summaryCompleted", value: { _privacyMode: privacyMode, hookMessage } },
    }
  },
  shellOutputDelta(privacyMode: PrivacyMode, event: unknown): RedactedInteractionUpdate {
    return {
      _privacyMode: privacyMode,
      message: { case: "shellOutputDelta", value: { _privacyMode: privacyMode, event } },
    }
  },
  feedbackRequest(
    requestId: string,
    canonicalModelName: string,
    privacyMode: PrivacyMode,
    categories: readonly RedactedFeedbackCategory[],
    categoryGroups: readonly RedactedFeedbackCategoryGroup[] = [],
    copy: {
      readonly title?: unknown
      readonly negativeTitle?: unknown
      readonly commentPlaceholder?: unknown
    } = {},
  ): RedactedInteractionUpdate {
    const toRedactedCategory = (category: RedactedFeedbackCategory) => ({
      _privacyMode: privacyMode,
      id: category.id,
      label: category.label,
    })
    return {
      _privacyMode: privacyMode,
      message: {
        case: "feedbackRequest",
        value: {
          _privacyMode: privacyMode,
          requestId,
          canonicalModelName,
          categories: categories.map(toRedactedCategory),
          categoryGroups: categoryGroups.map(group => ({
            _privacyMode: privacyMode,
            id: group.id,
            prompt: group.prompt,
            categories: group.categories.map(toRedactedCategory),
          })),
          showFormImmediately: false,
          title: copy.title,
          negativeTitle: copy.negativeTitle,
          commentPlaceholder: copy.commentPlaceholder,
        },
      },
    }
  },
}
