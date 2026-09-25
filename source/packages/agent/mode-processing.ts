/**
 * What a turn is told about the mode it is in, and what changes when the mode or the workspace changes.
 *
 * A mode is not only a permission setting: entering plan mode, leaving multitask mode, being in ask mode
 * instead of agent mode each come with something the model has to be told, and the telling is what makes
 * the mode real. So the reminder for a turn is assembled from three places: what leaving the previous mode
 * requires (leaving multitask mode has its own note), what the mode now requires (each mode's own generator,
 * with multitask mode building its own reminder from the tool that launches subagents), and what the switch
 * itself requires when the mode actually changed.
 *
 * The same applies to the workspace. A turn that runs in a different set of folders than the last one has
 * to be told, because every path it remembers is now wrong, and one case deserves its own sentence: a
 * single folder that is a worktree. A turn that moved between running locally and running on a remote
 * machine is told that too, because the rules about Git differ between them.
 *
 * The mode a turn runs in and the mode a step runs in are two different questions, and they are answered
 * separately: a step keeps the mode it was started in, so a mode change mid-turn does not rewrite the
 * steps that already ran.
 */

import { createLogger } from "../context/index.ts"
import { AgentMode } from "../proto/generated/agent/v1/agent_pb.ts"
import { isWorktreesPath } from "../utils/paths.ts"
import { buildAntiAskQuestionSystemReminder } from "./prompts/ask-question-guidance.ts"
import { SwitchModeReminderSnippet } from "./prompts/legacy-snippets.ts"
import { usesPersistenceInstructions, type PersistenceModelInfo } from "./prompts/persistence-instructions.ts"
import {
  renderMultitaskModeEnterUserReminderInner,
  renderMultitaskModeExitUserReminder,
  renderStillInMultitaskModeReminder,
  type MultitaskModelInfo,
} from "./prompts/multitask-mode-reminders.ts"
import { WORKTREE_NOTE } from "./prompts/worktree-note.ts"
import { getTaskToolName, type TaskToolModelInfo } from "./tools/task-tool-name.ts"
import { AgentType } from "./utils/agent-config.ts"

type ModeModelInfo = TaskToolModelInfo & PersistenceModelInfo & MultitaskModelInfo

export interface ModeProcessingRequestContext {
  readonly debugModeConfig?: unknown
  readonly [key: string]: unknown
}

export interface ModeProcessingConfig {
  readonly planSystemReminderGenerator: (previousMode: AgentMode | undefined) => string
  readonly askSystemReminderGenerator: (options: {
    readonly prevTurnMode: AgentMode | undefined
    readonly requestContext: ModeProcessingRequestContext
  }) => string
  readonly debugSystemReminderGenerator: (
    debugModeConfig: unknown,
    enteringDebugMode: boolean,
  ) => string
  readonly triageSystemReminderGenerator: (previousMode: AgentMode | undefined) => string
  readonly projectSystemReminderGenerator?: ((previousMode: AgentMode | undefined) => string) | undefined
  readonly modelInfo?: ModeModelInfo | undefined
  readonly featureFlags?: {
    readonly hideAsyncSubagentTaskNotifications?: boolean | undefined
    readonly enableAntiAskQuestionSysReminder?: boolean | undefined
    readonly dropCustomPromptContext?: boolean | undefined
  } | undefined
  readonly switchModeToolConfig?: {
    readonly targetModes?: unknown
    readonly fromModes?: unknown
  } | undefined
  readonly userInfoDisplayOptions?: {
    readonly disable?: boolean | undefined
    readonly displayCursorRules?: boolean | undefined
  } | undefined
  readonly askQuestionToolName?: string | undefined
}

createLogger("@slate/agent:mode-processing")

/** The mode as the product names it, which is what a reminder about switching modes says. */
function agentModeToModeId(mode: AgentMode): string {
  switch (mode) {
    case AgentMode.AGENT: return "agent"
    case AgentMode.ASK: return "chat"
    case AgentMode.PLAN: return "plan"
    case AgentMode.DEBUG: return "debug"
    case AgentMode.TRIAGE: return "triage"
    case AgentMode.PROJECT: return "project"
    case AgentMode.MULTITASK: return "multitask"
    default: return "agent"
  }
}

/** What the user asked for this turn wins; otherwise the mode the conversation is in. */
export function resolveCurrentTurnMode(
  persistedMode: AgentMode | undefined,
  userMessageMode: AgentMode | undefined,
): AgentMode {
  if (userMessageMode !== undefined && userMessageMode !== AgentMode.UNSPECIFIED) {
    return userMessageMode
  }
  if (persistedMode !== undefined && persistedMode !== AgentMode.UNSPECIFIED) {
    return persistedMode
  }
  return AgentMode.AGENT
}

/** A step keeps the mode it was started in, whatever the turn has moved on to. */
export function resolveCurrentStepMode(
  persistedMode: AgentMode | undefined,
  userMessageMode: AgentMode | undefined,
): AgentMode {
  if (persistedMode !== undefined && persistedMode !== AgentMode.UNSPECIFIED) {
    return persistedMode
  }
  return resolveCurrentTurnMode(persistedMode, userMessageMode)
}

export function processModeSystemReminder(
  mode: AgentMode,
  config: ModeProcessingConfig,
  requestContext: ModeProcessingRequestContext,
  previousMode?: AgentMode,
  options?: { readonly isUserTurn?: boolean | undefined },
): string {
  const isUserTurn = options?.isUserTurn ?? true
  const hasModeSwitch = previousMode !== undefined && previousMode !== mode
  // Leaving multitask mode is worth saying on its own, because the mode's instructions were the loudest.
  const leftMultitask = previousMode !== undefined &&
    previousMode !== AgentMode.UNSPECIFIED &&
    previousMode === AgentMode.MULTITASK &&
    mode !== AgentMode.MULTITASK
  const exitMultitaskReminder = leftMultitask ? renderMultitaskModeExitUserReminder() : ""
  let modeReminder = ""
  switch (mode) {
    case AgentMode.AGENT:
    case AgentMode.UNSPECIFIED:
      break
    case AgentMode.PLAN:
      modeReminder = config.planSystemReminderGenerator(previousMode)
      break
    case AgentMode.ASK:
      modeReminder = config.askSystemReminderGenerator({
        prevTurnMode: previousMode,
        requestContext,
      })
      break
    case AgentMode.DEBUG:
      modeReminder = config.debugSystemReminderGenerator(
        requestContext.debugModeConfig,
        previousMode !== AgentMode.DEBUG,
      )
      break
    case AgentMode.TRIAGE:
      modeReminder = config.triageSystemReminderGenerator(previousMode)
      break
    case AgentMode.PROJECT:
      modeReminder = config.projectSystemReminderGenerator
        ? config.projectSystemReminderGenerator(previousMode)
        : ""
      break
    case AgentMode.MULTITASK: {
      // The mode's own instructions are for the user's turn; a step inside the turn is not re-told them.
      if (!isUserTurn) break
      if (previousMode === AgentMode.MULTITASK) {
        modeReminder = renderStillInMultitaskModeReminder({
          modelInfo: config.modelInfo,
          hideAsyncSubagentTaskNotifications:
            config.featureFlags?.hideAsyncSubagentTaskNotifications,
        })
        break
      }
      const subagentToolName = config.modelInfo !== undefined
        ? getTaskToolName(config.modelInfo)
        : "Task"
      const multitaskReminderInner = renderMultitaskModeEnterUserReminderInner(
        subagentToolName,
        {
          ignoreGptPersistenceInstructions: usesPersistenceInstructions(config.modelInfo),
          modelInfo: config.modelInfo,
          hideAsyncSubagentTaskNotifications:
            config.featureFlags?.hideAsyncSubagentTaskNotifications,
        },
      )
      modeReminder = `<system_reminder>\n${multitaskReminderInner}\n</system_reminder>`
      break
    }
    default:
      break
  }
  const trailingModeReminders = [exitMultitaskReminder, modeReminder]
    .filter(Boolean)
    .join("\n\n")
  if (hasModeSwitch) {
    const switchModeReminder = SwitchModeReminderSnippet({
      currentMode: agentModeToModeId(mode),
      targetModes: config.switchModeToolConfig?.targetModes,
      fromModes: config.switchModeToolConfig?.fromModes,
    })
    return trailingModeReminders
      ? `${switchModeReminder}\n\n${trailingModeReminders}`
      : switchModeReminder
  }
  return trailingModeReminders
}

export function joinUserTurnSystemReminders(...reminders: string[]): string {
  return reminders.filter(Boolean).join("\n\n")
}

/** The reminder that stops a session from asking a question instead of answering it. */
export function processAntiAskQuestionSystemReminder(config: ModeProcessingConfig): string {
  if (
    config.featureFlags?.enableAntiAskQuestionSysReminder !== true ||
    config.featureFlags?.dropCustomPromptContext === true ||
    config.userInfoDisplayOptions?.disable === true ||
    config.userInfoDisplayOptions?.displayCursorRules === false
  ) {
    return ""
  }
  const askQuestionToolName = config.askQuestionToolName ?? "AskQuestion"
  return buildAntiAskQuestionSystemReminder(askQuestionToolName)
}

/** Two sets of folders are the same set if they hold the same folders, whatever order they arrived in. */
function normalizeWorkspaceUris(workspaceUris: readonly string[]): string[] {
  const trimmedUris = workspaceUris.map(uri => uri.trim()).filter(uri => uri.length > 0)
  return trimmedUris.slice().sort((a, b) => a.localeCompare(b))
}

function formatWorkspaceUriList(workspaceUris: readonly string[]): string {
  if (workspaceUris.length === 0) return "none"
  return workspaceUris.join(", ")
}

function buildAgentEnvironmentTransitionReminder(
  currentAgentType: AgentType | undefined,
  previousAgentType: AgentType | undefined,
): string {
  // Where the work runs decides what the model may do with Git, so a move between the two is stated.
  if (
    previousAgentType === AgentType.BACKGROUND &&
    currentAgentType !== undefined &&
    currentAgentType !== AgentType.BACKGROUND
  ) {
    return "\n\nYou are now operating as an agent locally on the user's machine. Git commit and push commands should be carried out only when requested by the user (or as required by user rules / skills)."
  }
  if (
    currentAgentType === AgentType.BACKGROUND &&
    previousAgentType !== undefined &&
    previousAgentType !== AgentType.BACKGROUND
  ) {
    return "\n\nYou are now operating as a cloud agent on a remote machine. Manage your own Git state according to your Git instructions."
  }
  return ""
}

export function processWorkspaceChangeReminder(
  _ctx: unknown,
  currentWorkspaceUris: readonly string[],
  previousWorkspaceUris: readonly string[] | undefined,
  currentAgentType: AgentType | undefined,
  previousAgentType: AgentType | undefined,
): string {
  // A first turn has no previous workspace to have changed from.
  if (previousWorkspaceUris === undefined) return ""
  const normalizedPrevious = normalizeWorkspaceUris(previousWorkspaceUris)
  const normalizedCurrent = normalizeWorkspaceUris(currentWorkspaceUris)
  if (
    normalizedPrevious.length === normalizedCurrent.length &&
    normalizedPrevious.every((value, index) => value === normalizedCurrent[index])
  ) {
    return ""
  }
  let worktreeNote = ""
  if (normalizedCurrent.length === 1 && isWorktreesPath(normalizedCurrent[0]!)) {
    worktreeNote = ` ${WORKTREE_NOTE}`
  } else {
    worktreeNote =
      " Your workspace path has changed, and all future edits should be performed in the new workspace folders."
  }
  const agentEnvironmentTransitionReminder = buildAgentEnvironmentTransitionReminder(
    currentAgentType,
    previousAgentType,
  )
  return `<system_reminder>\nWorkspace folders changed from ${formatWorkspaceUriList(normalizedPrevious)} to ${formatWorkspaceUriList(normalizedCurrent)}.${worktreeNote}${agentEnvironmentTransitionReminder}\n</system_reminder>`
}
