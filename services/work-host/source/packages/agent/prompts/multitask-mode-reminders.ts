/** Guidance for entering, continuing and leaving Slate's multitask mode. */

export interface MultitaskReminderPolicy {
  readonly strictDelegation?: boolean | undefined
  readonly ignoreTurnPersistenceInstructions?: boolean | undefined
}

export interface MultitaskReminderOptions {
  readonly policy?: MultitaskReminderPolicy | undefined
  readonly hideAsyncSubagentTaskNotifications?: boolean | undefined
}

function strictDelegation(options: MultitaskReminderOptions): boolean {
  return options.policy?.strictDelegation === true
}

/** The detail shown when the current turn starts in multitask mode. */
export function renderMultitaskModeEnterUserReminderInner(
  subagentToolName: string,
  options: MultitaskReminderOptions = {},
): string {
  const strict = strictDelegation(options)
  const paragraphs = [
    "The user enabled Slate multitask mode. Remain in this mode until the user turns it off.",
    "You are coordinating the request. Give substantial work to a background worker with the " +
      subagentToolName + " tool, then stop your response instead of waiting or repeating that work.",
    "Choose one coherent worker task when context is shared. Use several workers only for clearly independent workstreams.",
    "In the foreground, handle coordination, a new independent request, or synthesis after workers return. Do not reproduce a task already assigned.",
    "Do not describe these coordination rules to the user unless asked.",
  ]

  if (strict) {
    paragraphs.push("For this session, send every tool-based task to a background worker, including a task that appears quick.")
  } else {
    paragraphs.push("A request needing no tool call, or one quick and direct call, may be handled in the foreground.")
  }

  if (!options.hideAsyncSubagentTaskNotifications) {
    paragraphs.push("A completed worker may provide a user-facing summary. Do not repeat a single summary unless the user asks or several results need to be combined.")
  }
  if (options.policy?.ignoreTurnPersistenceInstructions === true) {
    paragraphs.push("While multitask mode is active, stop after delegation even when general turn guidance says to keep working until completion.")
  }

  return paragraphs.join("\n\n")
}

/** Guidance for a turn that starts while the mode is already active. */
function renderStillInMultitaskModeReminderContent(options: MultitaskReminderOptions = {}): string {
  const paragraphs = [
    "You remain in Slate multitask mode. Decide whether to coordinate directly or assign this request to background workers.",
    "Use one worker for related work. Use several only when the request has independent workstreams.",
    "Do not wait for a worker or repeat its assigned work in the foreground.",
  ]

  if (strictDelegation(options)) {
    paragraphs.push("For this session, delegate every tool-based task, including quick checks.")
  } else {
    paragraphs.push("Handle a request directly only when it needs no tools or one quick call.")
  }
  if (!options.hideAsyncSubagentTaskNotifications) {
    paragraphs.push("Do not restate one worker's summary unless asked; combine results only when several workers return.")
  }
  return paragraphs.join("\n\n")
}

function renderMultitaskModeExitUserReminderContent(): string {
  return [
    "The user turned off Slate multitask mode.",
    "Continue with the usual task flow. Background workers remain available when they help and other instructions allow them.",
  ].join("\n\n")
}

export function renderMultitaskModeEnterUserReminder(
  subagentToolName: string,
  options: MultitaskReminderOptions = {},
): string {
  return "<system_reminder>\n" +
    renderMultitaskModeEnterUserReminderInner(subagentToolName, options) +
    "\n</system_reminder>"
}

export function renderStillInMultitaskModeReminder(options: MultitaskReminderOptions = {}): string {
  return "<system_reminder>\n" + renderStillInMultitaskModeReminderContent(options) + "\n</system_reminder>"
}

export function renderMultitaskModeExitUserReminder(): string {
  return "<system_reminder>\n" + renderMultitaskModeExitUserReminderContent() + "\n</system_reminder>"
}
