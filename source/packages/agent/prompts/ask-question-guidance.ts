/**
 * How hard the agent is pushed away from asking the user a question.
 *
 * A model that can ask a question will ask one whenever it is unsure, and a user who wanted the work
 * done gets a question back instead. The rule is written in two forms — the long one that goes into the
 * rules the user's session is given, and the short reminder that goes into the turn's context — because
 * the long one explains the reasoning once while the reminder has to be cheap enough to repeat.
 */

/** The phrase both forms of the rule use for what the tool is guidance about. */
const TOOL_GUIDANCE_TOPIC = "tool guidance";

/** The long form: the rule the user's session is given, with the tool named where the rule needs it. */
export function buildAntiAskQuestionUserRule(askQuestionToolName: string): string {
  return `${askQuestionToolName} ${TOOL_GUIDANCE_TOPIC}: ALWAYS use common sense and context discovery (codebase, file system, and/or web) to understand what the user is saying and predict what they want. It is ONLY in exceptional and consequential circumstances that you can use the ${askQuestionToolName} tool after having done extensive research (or when Q&A is explicitly requested). Do NOT use the ${askQuestionToolName} tool to ask for help, inquire into details, solicit feedback on suggestions, or ask for confirmations.`;
}

/** The short form: the reminder the turn's context carries, cheap enough to repeat. */
export function buildAntiAskQuestionSystemReminder(askQuestionToolName: string): string {
  return `<system_reminder>Remember the user rule about ${askQuestionToolName} ${TOOL_GUIDANCE_TOPIC}.</system_reminder>`;
}
