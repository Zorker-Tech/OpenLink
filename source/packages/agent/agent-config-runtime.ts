import { DISABLED_BACKGROUND_SUMMARIZATION_PROPS } from "../agent-summarization/background-summarization.ts";
import { MAX_AGENT_STEPS } from "./constants.ts";
import { filterByActorIdentity, type ScopedItem } from "./utils/rule-scoping.ts";
import { slateModelCapabilitiesFromInterop } from "../../adapters/interop/agent/model-capabilities-adapter.ts";

export interface AgentRuntimeNonFileRule extends ScopedItem {
  readonly fullPath: string;
}

export interface AgentRuntimeConfigInput {
  readonly systemPromptGenerator?: unknown;
  readonly maxSteps?: number | null;
  readonly actorIdentity?: { readonly email: string } | undefined;
  readonly nonFileRules?: readonly AgentRuntimeNonFileRule[] | undefined;
  readonly [setting: string]: unknown;
}

interface ReminderGenerators {
  readonly planSystemReminderGenerator: () => string;
  readonly askSystemReminderGenerator: (options: unknown) => string;
  readonly debugSystemReminderGenerator: (mode: unknown, isFirstMessage: unknown) => string;
  readonly triageSystemReminderGenerator: () => string;
  readonly projectSystemReminderGenerator: () => string;
}

interface RuntimeSwitches {
  readonly immediatelyUpdateStateOnNewTurn: boolean;
  readonly smartModeClassifierMode: boolean;
  readonly smartModeClassifierShadowMode: boolean;
  readonly doNotFailOnMaxSteps: boolean;
  readonly enableAgentNotes: boolean;
  readonly enableTerminalFiles: boolean;
  readonly enableImageFiles: boolean;
  readonly enableLongCodeSelectionSpillToFile: boolean;
  readonly enableToolArgPreservation: boolean;
  readonly strictArgParsing: boolean;
  readonly enableExecuteHookExec: boolean;
  readonly enableTranscriptInSummary: boolean;
  readonly summarizeActionClearTurns: boolean;
  readonly fireAndForgetCheckpoints: boolean;
  readonly skipErrorStateCheckpoint: boolean;
  readonly enablePrependedUserActions: boolean;
}

interface RuntimeConfigDefaults extends ReminderGenerators, RuntimeSwitches {
  readonly backgroundSummarizationProps: typeof DISABLED_BACKGROUND_SUMMARIZATION_PROPS;
  readonly formattingOptions: Record<string, unknown>;
  readonly nonFileRules: AgentRuntimeNonFileRule[];
}

export interface NormalizedAgentConfig extends Record<string, unknown>, RuntimeConfigDefaults {
  readonly systemPromptGenerator: unknown;
  readonly maxSteps: number;
  readonly actorIdentity?: { readonly email: string } | undefined;
  readonly nonFileRules: AgentRuntimeNonFileRule[];
}

function createReminderGenerators(): ReminderGenerators {
  return {
    planSystemReminderGenerator: () => "",
    askSystemReminderGenerator: (_options) => "",
    debugSystemReminderGenerator: (_mode, _isFirstMessage) => "",
    triageSystemReminderGenerator: () => "",
    projectSystemReminderGenerator: () => "",
  };
}

function createRuntimeSwitches(): RuntimeSwitches {
  return {
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
  };
}

function createRuntimeDefaults(): RuntimeConfigDefaults {
  return {
    ...createReminderGenerators(),
    backgroundSummarizationProps: DISABLED_BACKGROUND_SUMMARIZATION_PROPS,
    formattingOptions: {
      shouldUseFormatCodeblock: true,
      gpt5StyleLineNumbers: false,
      gpt5CodexCatN: false,
    },
    nonFileRules: [],
    ...createRuntimeSwitches(),
  };
}

function applyActorScope(rules: readonly AgentRuntimeNonFileRule[], actor: AgentRuntimeConfigInput["actorIdentity"]): AgentRuntimeNonFileRule[] {
  return filterByActorIdentity(rules, actor);
}

export function normalizeAgentConfig(config: AgentRuntimeConfigInput): NormalizedAgentConfig {
  if (config.systemPromptGenerator === undefined) {
    throw new Error("systemPromptGenerator is required");
  }

  const merged = {
    ...createRuntimeDefaults(),
    ...config,
    maxSteps: config.maxSteps ?? MAX_AGENT_STEPS,
  } as NormalizedAgentConfig;

  return {
    ...merged,
    ...(merged.modelInfo === undefined ? {} : { modelInfo: slateModelCapabilitiesFromInterop(merged.modelInfo) }),
    nonFileRules: applyActorScope(merged.nonFileRules, merged.actorIdentity),
  };
}
