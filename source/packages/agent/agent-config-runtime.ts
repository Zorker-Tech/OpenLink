import { DISABLED_BACKGROUND_SUMMARIZATION_PROPS } from "../agent-summarization/background-summarization.ts";
import { MAX_AGENT_STEPS } from "./constants.ts";
import { filterByActorIdentity } from "./utils/rule-scoping.ts";

type Any = any;

/**
 * The defaults a session is given before its own configuration is applied.
 *
 * A session's configuration arrives as whatever the caller had to say, and everything it did not mention has
 * to have a value: the generators that produce nothing until a mode or a debug session asks for something,
 * the formatting options that decide how code is written out, and the switches that are off unless a session
 * turns them on. They are applied here rather than at each use so that a missing field is a default rather
 * than a crash, and the one field that has no sensible default — the system prompt generator — is refused
 * rather than defaulted, because a session with no instructions is not a session.
 *
 * Two of the defaults are computed rather than fixed. The step ceiling comes from the platform's own
 * constant, and the rules a session carries are filtered by who the session is, since a rule scoped to
 * somebody else must not be applied just because it was in the list.
 */
export function normalizeAgentConfig(config: Any): Any {
  if (config.systemPromptGenerator === undefined) {
    throw new Error("systemPromptGenerator is required");
  }

  const normalized = {
    planSystemReminderGenerator: () => "",
    askSystemReminderGenerator: (_options: Any) => "",
    debugSystemReminderGenerator: (_debugModeConfig: Any, _isFirstDebugModeMessage: Any) => "",
    triageSystemReminderGenerator: () => "",
    projectSystemReminderGenerator: () => "",
    backgroundSummarizationProps: DISABLED_BACKGROUND_SUMMARIZATION_PROPS,
    formattingOptions: {
      shouldUseFormatCodeblock: true,
      gpt5StyleLineNumbers: false,
      gpt5CodexCatN: false,
    },
    nonFileRules: [],
    immediatelyUpdateStateOnNewTurn: false,
    smartModeClassifierMode: false,
    smartModeClassifierShadowMode: false,
    doNotFailOnMaxSteps: false,
    enableAgentNotes: false,
    enableTerminalFiles: true,
    enableImageFiles: false,
    enableLongCodeSelectionSpillToFile: true,
    enableToolArgPreservation: true,
    strictArgParsing: false,
    enableExecuteHookExec: false,
    enableTranscriptInSummary: true,
    summarizeActionClearTurns: false,
    fireAndForgetCheckpoints: false,
    skipErrorStateCheckpoint: false,
    enablePrependedUserActions: true,
    ...config,
    maxSteps: config.maxSteps ?? MAX_AGENT_STEPS,
  };

  normalized.nonFileRules = filterByActorIdentity(
    normalized.nonFileRules,
    normalized.actorIdentity,
  );
  return normalized;
}
