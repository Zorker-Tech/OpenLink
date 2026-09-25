import { test } from "node:test"
import assert from "node:assert/strict"

import {
  joinUserTurnSystemReminders,
  processAntiAskQuestionSystemReminder,
  processModeSystemReminder,
  processWorkspaceChangeReminder,
  resolveCurrentStepMode,
  resolveCurrentTurnMode,
  type ModeProcessingConfig,
  type ModeProcessingRequestContext,
} from "../../source/packages/agent/mode-processing.ts"
import { AgentMode } from "../../source/packages/proto/generated/agent/v1/agent_pb.ts"
import { AgentType } from "../../source/packages/agent/utils/agent-config.ts"
import { WORKTREE_NOTE } from "../../source/packages/agent/prompts/worktree-note.ts"

// ---------------------------------------------------------------------------------------------
// which mode a turn and a step run in
// ---------------------------------------------------------------------------------------------

test("the mode the user asked for this turn wins over the one the conversation is in", () => {
  assert.equal(resolveCurrentTurnMode(AgentMode.PLAN, AgentMode.AGENT), AgentMode.AGENT)
  assert.equal(resolveCurrentTurnMode(AgentMode.PLAN, undefined), AgentMode.PLAN)
  assert.equal(resolveCurrentTurnMode(AgentMode.PLAN, AgentMode.UNSPECIFIED), AgentMode.PLAN)
  assert.equal(resolveCurrentTurnMode(undefined, undefined), AgentMode.AGENT)
  assert.equal(resolveCurrentTurnMode(AgentMode.UNSPECIFIED, AgentMode.UNSPECIFIED), AgentMode.AGENT)
})

test("a step keeps the mode it was started in", () => {
  assert.equal(resolveCurrentStepMode(AgentMode.PLAN, AgentMode.AGENT), AgentMode.PLAN)
  assert.equal(resolveCurrentStepMode(undefined, AgentMode.ASK), AgentMode.ASK)
  assert.equal(resolveCurrentStepMode(AgentMode.UNSPECIFIED, AgentMode.ASK), AgentMode.ASK)
  assert.equal(resolveCurrentStepMode(undefined, undefined), AgentMode.AGENT)
})

// ---------------------------------------------------------------------------------------------
// what a turn is told about its mode
// ---------------------------------------------------------------------------------------------

interface Calls {
  readonly plan: Array<AgentMode | undefined>
  readonly ask: Array<{ prevTurnMode: AgentMode | undefined; requestContext: ModeProcessingRequestContext }>
  readonly debug: Array<{ config: unknown; entering: boolean }>
  readonly triage: Array<AgentMode | undefined>
  readonly project: Array<AgentMode | undefined>
}

function configWith(calls: Calls, overrides: Partial<ModeProcessingConfig> = {}): ModeProcessingConfig {
  return {
    planSystemReminderGenerator: previousMode => { calls.plan.push(previousMode); return "PLAN REMINDER" },
    askSystemReminderGenerator: options => { calls.ask.push(options); return "ASK REMINDER" },
    debugSystemReminderGenerator: (config, entering) => { calls.debug.push({ config, entering }); return "DEBUG REMINDER" },
    triageSystemReminderGenerator: previousMode => { calls.triage.push(previousMode); return "TRIAGE REMINDER" },
    projectSystemReminderGenerator: previousMode => { calls.project.push(previousMode); return "PROJECT REMINDER" },
    ...overrides,
  }
}

const emptyCalls = (): Calls => ({ plan: [], ask: [], debug: [], triage: [], project: [] })

test("agent mode needs nothing said about it", () => {
  const calls = emptyCalls()
  assert.equal(processModeSystemReminder(AgentMode.AGENT, configWith(calls), {}), "")
  assert.equal(processModeSystemReminder(AgentMode.UNSPECIFIED, configWith(calls), {}), "")
  assert.deepEqual(calls, emptyCalls())
})

test("each mode's reminder comes from its own generator, with what that generator needs", () => {
  const calls = emptyCalls()
  const config = configWith(calls)
  // Each of these is a change of mode, so the mode's own reminder follows the statement of the switch.
  const plan = processModeSystemReminder(AgentMode.PLAN, config, {}, AgentMode.AGENT)
  assert.match(plan, /PLAN REMINDER$/)
  assert.match(plan, /You are now in Plan mode\./)

  const ask = processModeSystemReminder(AgentMode.ASK, config, { debugModeConfig: { level: 2 } }, AgentMode.PLAN)
  assert.match(ask, /ASK REMINDER$/)
  assert.match(ask, /You are now in Ask mode\./)

  assert.match(processModeSystemReminder(AgentMode.TRIAGE, config, {}, AgentMode.AGENT), /TRIAGE REMINDER$/)
  assert.match(processModeSystemReminder(AgentMode.PROJECT, config, {}, AgentMode.AGENT), /PROJECT REMINDER$/)

  assert.deepEqual(calls.plan, [AgentMode.AGENT])
  assert.deepEqual(calls.ask, [{ prevTurnMode: AgentMode.PLAN, requestContext: { debugModeConfig: { level: 2 } } }])
  assert.deepEqual(calls.triage, [AgentMode.AGENT])
  assert.deepEqual(calls.project, [AgentMode.AGENT])
})

test("debug mode says whether it is being entered for the first time", () => {
  const calls = emptyCalls()
  const config = configWith(calls)
  processModeSystemReminder(AgentMode.DEBUG, config, { debugModeConfig: "the config" }, AgentMode.AGENT)
  processModeSystemReminder(AgentMode.DEBUG, config, {}, AgentMode.DEBUG)
  processModeSystemReminder(AgentMode.DEBUG, config, {}, undefined)
  assert.deepEqual(calls.debug, [
    { config: "the config", entering: true },
    { config: undefined, entering: false },
    { config: undefined, entering: true },
  ])
})

test("a project mode with no generator of its own says nothing", () => {
  const calls = emptyCalls()
  const config = configWith(calls, { projectSystemReminderGenerator: undefined })
  assert.equal(processModeSystemReminder(AgentMode.PROJECT, config, {}), "")
})

test("entering multitask mode names the tool that launches subagents", () => {
  const calls = emptyCalls()
  const withModel = configWith(calls, { modelInfo: { promptVersion: "latest", isComposer1: true } })
  const reminder = processModeSystemReminder(AgentMode.MULTITASK, withModel, {}, AgentMode.AGENT)
  assert.match(reminder, /^<system_reminder>\n/)
  assert.match(reminder, /mcp_task/)
  assert.match(reminder, /\n<\/system_reminder>$/)

  const withoutModel = processModeSystemReminder(AgentMode.MULTITASK, configWith(emptyCalls()), {}, AgentMode.AGENT)
  assert.match(withoutModel, /Task/)
})

test("a step inside a multitask turn is not told the mode's instructions again", () => {
  const calls = emptyCalls()
  const config = configWith(calls)
  // Already in the mode, so nothing is said at all.
  assert.equal(processModeSystemReminder(AgentMode.MULTITASK, config, {}, AgentMode.MULTITASK, { isUserTurn: false }), "")

  // Entering it, the switch is still worth stating, but the delegation instructions are not repeated.
  const entering = processModeSystemReminder(AgentMode.MULTITASK, config, {}, AgentMode.AGENT, { isUserTurn: false })
  assert.match(entering, /You are now in Multitask mode\./)
  assert.doesNotMatch(entering, /delegation_examples/)
})

test("staying in multitask mode has its own reminder", () => {
  const calls = emptyCalls()
  const staying = processModeSystemReminder(AgentMode.MULTITASK, configWith(calls), {}, AgentMode.MULTITASK)
  const entering = processModeSystemReminder(AgentMode.MULTITASK, configWith(calls), {}, AgentMode.AGENT)
  assert.notEqual(staying, entering)
  assert.match(staying, /You are still in \*\*Multitask Mode\*\*\./)
  assert.doesNotMatch(staying, /You are now in Multitask mode\./)
  assert.match(entering, /delegation_examples/)
})

test("leaving multitask mode is said before what the new mode requires", () => {
  const calls = emptyCalls()
  const reminder = processModeSystemReminder(AgentMode.PLAN, configWith(calls), {}, AgentMode.MULTITASK)
  assert.match(reminder, /do not continue with the aggressive multitasking strategy/)
  assert.match(reminder, /PLAN REMINDER/)
  assert.equal(reminder.indexOf("multitasking strategy") < reminder.indexOf("PLAN REMINDER"), true)
})

test("a mode that did not change is not described as a switch", () => {
  const calls = emptyCalls()
  const reminder = processModeSystemReminder(AgentMode.PLAN, configWith(calls), {}, AgentMode.PLAN)
  assert.equal(reminder, "PLAN REMINDER")

  // And a first turn, with no previous mode at all, is not a switch either.
  assert.equal(processModeSystemReminder(AgentMode.PLAN, configWith(calls), {}, undefined), "PLAN REMINDER")
})

test("a mode switch says which mode the turn is now in, before what that mode requires", () => {
  const calls = emptyCalls()
  const config = configWith(calls, { switchModeToolConfig: { targetModes: ["agent", "plan"], fromModes: ["chat"] } })
  const reminder = processModeSystemReminder(AgentMode.ASK, config, {}, AgentMode.AGENT)
  assert.match(reminder, /You are now in Ask mode\. You have EXITED your previous mode\./)
  assert.match(reminder, /ASK REMINDER/)
  assert.equal(reminder.indexOf("You are now in Ask mode") < reminder.indexOf("ASK REMINDER"), true)
  // The mode is named the way the product names it rather than by its internal id.
  assert.doesNotMatch(reminder, /You are now in chat mode/)
})

test("reminders for one user turn are joined, and the empty ones dropped", () => {
  assert.equal(joinUserTurnSystemReminders("a", "", "b", ""), "a\n\nb")
  assert.equal(joinUserTurnSystemReminders("", ""), "")
  assert.equal(joinUserTurnSystemReminders(), "")
})

// ---------------------------------------------------------------------------------------------
// the reminder that stops a session asking instead of answering
// ---------------------------------------------------------------------------------------------

test("the anti-question reminder is only sent when the session is set up for it", () => {
  const enabled: ModeProcessingConfig = {
    planSystemReminderGenerator: () => "",
    askSystemReminderGenerator: () => "",
    debugSystemReminderGenerator: () => "",
    triageSystemReminderGenerator: () => "",
    featureFlags: { enableAntiAskQuestionSysReminder: true },
    askQuestionToolName: "AskQuestion",
  }
  assert.match(processAntiAskQuestionSystemReminder(enabled), /AskQuestion/)

  assert.equal(processAntiAskQuestionSystemReminder({ ...enabled, featureFlags: {} }), "")
  assert.equal(
    processAntiAskQuestionSystemReminder({ ...enabled, featureFlags: { enableAntiAskQuestionSysReminder: true, dropCustomPromptContext: true } }),
    "",
  )
  assert.equal(processAntiAskQuestionSystemReminder({ ...enabled, userInfoDisplayOptions: { disable: true } }), "")
  assert.equal(processAntiAskQuestionSystemReminder({ ...enabled, userInfoDisplayOptions: { displayCursorRules: false } }), "")
})

test("the reminder names the session's own question tool", () => {
  const config: ModeProcessingConfig = {
    planSystemReminderGenerator: () => "",
    askSystemReminderGenerator: () => "",
    debugSystemReminderGenerator: () => "",
    triageSystemReminderGenerator: () => "",
    featureFlags: { enableAntiAskQuestionSysReminder: true },
  }
  assert.match(processAntiAskQuestionSystemReminder(config), /AskQuestion/)
  assert.match(processAntiAskQuestionSystemReminder({ ...config, askQuestionToolName: "Clarify" }), /Clarify/)
})

// ---------------------------------------------------------------------------------------------
// what a turn is told when its workspace changed
// ---------------------------------------------------------------------------------------------

const worktreePath = "/Users/someone/repo/.slate/worktrees/repo/feature-branch"

test("a first turn has no previous workspace to have changed from", () => {
  assert.equal(processWorkspaceChangeReminder(undefined, ["/repo"], undefined, undefined, undefined), "")
})

test("a workspace that is the same set of folders is not a change", () => {
  assert.equal(processWorkspaceChangeReminder(undefined, ["/repo/a"], ["/repo/a"], undefined, undefined), "")
  // The order and the surrounding whitespace do not make it a different set.
  assert.equal(
    processWorkspaceChangeReminder(undefined, [" /repo/b", "/repo/a "], ["/repo/a", "/repo/b"], undefined, undefined),
    "",
  )
  // An empty folder is not a folder.
  assert.equal(processWorkspaceChangeReminder(undefined, ["/repo/a", "  "], ["/repo/a"], undefined, undefined), "")
})

test("a changed workspace is named, with what that means for the edits to come", () => {
  const reminder = processWorkspaceChangeReminder(undefined, ["/repo/new"], ["/repo/old"], undefined, undefined)
  assert.match(reminder, /^<system_reminder>\nWorkspace folders changed from \/repo\/old to \/repo\/new\./)
  assert.match(reminder, /all future edits should be performed in the new workspace folders\./)
  assert.doesNotMatch(reminder, /worktree/)
})

test("a single worktree folder gets the worktree note instead", () => {
  const reminder = processWorkspaceChangeReminder(undefined, [worktreePath], ["/repo"], undefined, undefined)
  assert.match(reminder, new RegExp(WORKTREE_NOTE.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")))
  assert.doesNotMatch(reminder, /all future edits should be performed/)

  // A worktree among other folders is not the case the note is for.
  const amongOthers = processWorkspaceChangeReminder(undefined, [worktreePath, "/repo/other"], ["/repo"], undefined, undefined)
  assert.doesNotMatch(amongOthers, new RegExp(WORKTREE_NOTE.slice(0, 30)))
})

test("a move between running locally and running remotely is stated", () => {
  const toLocal = processWorkspaceChangeReminder(undefined, ["/repo/new"], ["/repo/old"], AgentType.IDE, AgentType.BACKGROUND)
  assert.match(toLocal, /You are now operating as an agent locally on the user's machine\./)

  const toRemote = processWorkspaceChangeReminder(undefined, ["/repo/new"], ["/repo/old"], AgentType.BACKGROUND, AgentType.IDE)
  assert.match(toRemote, /You are now operating as a cloud agent on a remote machine\./)

  const bothRemote = processWorkspaceChangeReminder(undefined, ["/repo/new"], ["/repo/old"], AgentType.BACKGROUND, AgentType.BACKGROUND)
  assert.doesNotMatch(bothRemote, /You are now operating as/)

  const firstTurnRemote = processWorkspaceChangeReminder(undefined, ["/repo/new"], ["/repo/old"], AgentType.BACKGROUND, undefined)
  assert.doesNotMatch(firstTurnRemote, /You are now operating as/)

  const leftRemote = processWorkspaceChangeReminder(undefined, ["/repo/new"], ["/repo/old"], undefined, AgentType.BACKGROUND)
  assert.doesNotMatch(leftRemote, /You are now operating as/)
})

test("a workspace that emptied out says so rather than listing nothing", () => {
  const reminder = processWorkspaceChangeReminder(undefined, [], ["/repo/old"], undefined, undefined)
  assert.match(reminder, /changed from \/repo\/old to none\./)
})
