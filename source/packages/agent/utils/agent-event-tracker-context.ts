import { createKey, type Context } from "../../context/index.ts"
import type { AgentEventTracker } from "./agent-event-tracker-contracts.ts"

const ignoreEvent = (): void => {}

function createInactiveTracker(): AgentEventTracker {
  return {
    trackUnfinishedTodos: ignoreEvent,
    trackUnfinishedTodosWhenCreatedTodos: ignoreEvent,
    trackUnfinishedTodosWhenHadUnfinishedTodosAtStart: ignoreEvent,
    trackSummarizationTriggered: ignoreEvent,
    trackPromptTokens: ignoreEvent,
    trackNumberOfToolCalls: ignoreEvent,
    trackToolCallStarted: ignoreEvent,
    trackToolCallResult: ignoreEvent,
    trackComputerUseExecution: ignoreEvent,
    trackLoopDetected: ignoreEvent,
    trackSubagentCreated: ignoreEvent,
    trackSubagentCompleted: ignoreEvent,
    trackShellSandboxResult: ignoreEvent,
    trackSkillUsed: ignoreEvent,
    trackSkillApplied: ignoreEvent,
    trackHookExecuted: ignoreEvent,
    trackSmartModeClassifierCall: ignoreEvent,
    trackPlanModeModelFinished: ignoreEvent,
    trackMcpToolCall: ignoreEvent,
    trackMcpToolCallResult: ignoreEvent,
  }
}

/** A process can install its own event sink; contexts without one quietly discard reports. */
export const agentEventTrackerKey = createKey<AgentEventTracker>(
  Symbol("agentEventTracker"),
  createInactiveTracker(),
)

export function getAgentEventTracker(context: Context): AgentEventTracker {
  return context.get(agentEventTrackerKey)
}
