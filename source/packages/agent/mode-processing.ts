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
import { isWorktreesPath } from "../utils/paths.ts"
import { buildAntiAskQuestionSystemReminder } from "./prompts/ask-question-guidance.ts"
import { SwitchModeReminderSnippet } from "./prompts/legacy-snippets.ts"
import {
  renderMultitaskModeEnterUserReminderInner,
  renderMultitaskModeExitUserReminder,
  renderStillInMultitaskModeReminder,
  type MultitaskReminderPolicy,
} from "./prompts/multitask-mode-reminders.ts"
import { WORKTREE_NOTE } from "./prompts/worktree-note.ts"
import { AgentType } from "./utils/agent-config.ts"

/** Slate's internal mode vocabulary. Wire enum values are translated at the interop boundary. */
export const SlateMode = {
  AGENT: "agent",
  CHAT: "chat",
  PLAN: "plan",
  DEBUG: "debug",
  TRIAGE: "triage",
  PROJECT: "project",
  MULTITASK: "multitask",
  CUSTOM: "custom",
  UNSPECIFIED: "unspecified",
} as const

export type SlateMode = typeof SlateMode[keyof typeof SlateMode]

export interface ModeProcessingRequestContext {
  readonly debugModeConfig?: unknown
  readonly [key: string]: unknown
}

export interface ModeProcessingConfig {
  readonly planSystemReminderGenerator: (previousMode: SlateMode | undefined) => string
  readonly askSystemReminderGenerator: (options: {
    readonly prevTurnMode: SlateMode | undefined
    readonly requestContext: ModeProcessingRequestContext
  }) => string
  readonly debugSystemReminderGenerator: (
    debugModeConfig: unknown,
    enteringDebugMode: boolean,
  ) => string
  readonly triageSystemReminderGenerator: (previousMode: SlateMode | undefined) => string
  readonly projectSystemReminderGenerator?: ((previousMode: SlateMode | undefined) => string) | undefined
  readonly multitaskReminder?: {
    readonly subagentToolName?: string | undefined
    readonly policy?: MultitaskReminderPolicy | undefined
  } | undefined
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
    readonly displayWorkspaceRules?: boolean | undefined
  } | undefined
  readonly askQuestionToolName?: string | undefined
}

createLogger("@slate/agent:mode-processing")

/** The names Slate presents in its mode-switch reminder. */
const SWITCH_MODE_IDS: Partial<Record<SlateMode, string>> = {
  [SlateMode.AGENT]: "agent",
  [SlateMode.CHAT]: "chat",
  [SlateMode.PLAN]: "plan",
  [SlateMode.DEBUG]: "debug",
  [SlateMode.TRIAGE]: "triage",
  [SlateMode.PROJECT]: "project",
  [SlateMode.MULTITASK]: "multitask",
}

function agentModeToModeId(mode: SlateMode): string {
  return SWITCH_MODE_IDS[mode] ?? "agent"
}

/** What the user asked for this turn wins; otherwise the mode the conversation is in. */
export function resolveCurrentTurnMode(
  persistedMode: SlateMode | undefined,
  userMessageMode: SlateMode | undefined,
): SlateMode {
  if (userMessageMode !== undefined && userMessageMode !== SlateMode.UNSPECIFIED) {
    return userMessageMode
  }
  if (persistedMode !== undefined && persistedMode !== SlateMode.UNSPECIFIED) {
    return persistedMode
  }
  return SlateMode.AGENT
}

/** A step keeps the mode it was started in, whatever the turn has moved on to. */
export function resolveCurrentStepMode(
  persistedMode: SlateMode | undefined,
  userMessageMode: SlateMode | undefined,
): SlateMode {
  if (persistedMode !== undefined && persistedMode !== SlateMode.UNSPECIFIED) {
    return persistedMode
  }
  return resolveCurrentTurnMode(persistedMode, userMessageMode)
}

interface ModeReminderInput {
  readonly config: ModeProcessingConfig
  readonly requestContext: ModeProcessingRequestContext
  readonly previousMode: SlateMode | undefined
  readonly isUserTurn: boolean
}

type ModeReminderPolicy = (input: ModeReminderInput) => string

function multitaskReminder({ config, previousMode, isUserTurn }: ModeReminderInput): string {
  if (!isUserTurn) return ""
  const reminderOptions = {
    policy: config.multitaskReminder?.policy,
    hideAsyncSubagentTaskNotifications: config.featureFlags?.hideAsyncSubagentTaskNotifications,
  }
  if (previousMode === SlateMode.MULTITASK) {
    return renderStillInMultitaskModeReminder(reminderOptions)
  }
  const subagentToolName = config.multitaskReminder?.subagentToolName ?? "Task"
  const reminder = renderMultitaskModeEnterUserReminderInner(subagentToolName, reminderOptions)
  return `<system_reminder>\n${reminder}\n</system_reminder>`
}

const MODE_REMINDER_POLICIES: Partial<Record<SlateMode, ModeReminderPolicy>> = {
  [SlateMode.PLAN]: ({ config, previousMode }) => config.planSystemReminderGenerator(previousMode),
  [SlateMode.CHAT]: ({ config, previousMode, requestContext }) => config.askSystemReminderGenerator({
    prevTurnMode: previousMode,
    requestContext,
  }),
  [SlateMode.DEBUG]: ({ config, previousMode, requestContext }) => config.debugSystemReminderGenerator(
    requestContext.debugModeConfig,
    previousMode !== SlateMode.DEBUG,
  ),
  [SlateMode.TRIAGE]: ({ config, previousMode }) => config.triageSystemReminderGenerator(previousMode),
  [SlateMode.PROJECT]: ({ config, previousMode }) => config.projectSystemReminderGenerator?.(previousMode) ?? "",
  [SlateMode.MULTITASK]: multitaskReminder,
}

export function processModeSystemReminder(
  mode: SlateMode,
  config: ModeProcessingConfig,
  requestContext: ModeProcessingRequestContext,
  previousMode?: SlateMode,
  options?: { readonly isUserTurn?: boolean | undefined },
): string {
  const isUserTurn = options?.isUserTurn ?? true
  const hasModeSwitch = previousMode !== undefined && previousMode !== mode
  // Leaving multitask mode is worth saying on its own, because the mode's instructions were the loudest.
  const leftMultitask = previousMode !== undefined &&
    previousMode !== SlateMode.UNSPECIFIED &&
    previousMode === SlateMode.MULTITASK &&
    mode !== SlateMode.MULTITASK
  const exitMultitaskReminder = leftMultitask ? renderMultitaskModeExitUserReminder() : ""
  // Each mode owns its reminder policy; absent policies intentionally mean there is nothing to add.
  const modeReminder = MODE_REMINDER_POLICIES[mode]?.({ config, requestContext, previousMode, isUserTurn }) ?? ""
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
    config.userInfoDisplayOptions?.displayWorkspaceRules === false
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
