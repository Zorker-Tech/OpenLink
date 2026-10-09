/**
 * The inference a host offers the rest of itself.
 *
 * Which provider a turn runs on is the account's own choice, read where it is kept; when it is the platform's own
 * backend, the session is the platform's, and the tokens a routed model reported are written down against the
 * provider that reported them — a number the provider did not report is not written down, and a usage that could not
 * be recorded never fails the turn it belonged to. Everything else — the model a session resolves to, the gate that
 * turns the video API on, the experiment a turn is part of — is handed to the session factory as it was given, with
 * the one exception that reading the experiment is also what tells the host it was applied.
 */

import { join } from "node:path";

import { resolveComputerUseModelSelection, type SlateAgentModelSelection } from "../../../shared/agents/slate-agent-model.ts";
import type { SlateModelExperimentState } from "../../../shared/node/experiments/slate-model-experiment.ts";
import { SlateSettingsStore } from "../../../shared/node/settings/slate-settings-store.ts";
import type { SlateInferenceProvider } from "../../../shared/inference-router.ts";
import { getSlateRootDir } from "../../host-paths.ts";
import { createCursorSlateInference } from "./cursor-session.ts";
import { createProviderPromptSession } from "./provider-session.ts";
import type { PromptExecutor } from "./slate-labeling.ts";

/** The gate that turns the video API on for a turn. */
export const GEMINI_VIDEO_DEVELOPER_API_GATE = "gemini_video_developer_api";

export interface HostInferenceOptions {
  auth: { getAccessToken(...args: unknown[]): Promise<string>; getMachineId(): string };
  experiments: {
    checkFeatureGate(name: string): boolean;
    getComputerUseModelOverride(): SlateAgentModelSelection | undefined;
    getBrowserUseModelOverride(): SlateAgentModelSelection | undefined;
    getSlateModelExperimentState(): SlateModelExperimentState | null | undefined;
    hasHydratedStatsigUserId(): boolean;
    getConfiguredDefaultModel(): SlateAgentModelSelection | undefined;
    getConfiguredAutomationsModel(): SlateAgentModelSelection | undefined;
  };
  settings: {
    getAgentDefaultModel(): SlateAgentModelSelection | undefined;
    getComputerUseModel(): SlateAgentModelSelection | undefined;
    getInferenceProvider(): SlateInferenceProvider;
    recordInferenceUsage(provider: SlateInferenceProvider, usage: { inputTokens?: number; outputTokens?: number; cacheReadTokens?: number; cacheWriteTokens?: number }): void;
  };
  onModelExperimentApplied(): void;
}

/** The counts a provider reported, with everything it did not report left out. */
export function usageCountsFrom(usage: Record<string, unknown>): { inputTokens?: number; outputTokens?: number; cacheReadTokens?: number; cacheWriteTokens?: number } {
  return {
    ...(typeof usage.inputTokens === "number" ? { inputTokens: usage.inputTokens } : {}),
    ...(typeof usage.outputTokens === "number" ? { outputTokens: usage.outputTokens } : {}),
    ...(typeof usage.cacheReadTokens === "number" ? { cacheReadTokens: usage.cacheReadTokens } : {}),
    ...(typeof usage.cacheWriteTokens === "number" ? { cacheWriteTokens: usage.cacheWriteTokens } : {}),
  };
}

/**
 * An executor that writes down what a routed model spent, once the model says so: the stream's own answer is handed
 * back untouched, and a usage that arrived as a promise is awaited in the background.
 */
export function wrapExecutorWithUsageRecording(executor: PromptExecutor, provider: SlateInferenceProvider, recordUsage: HostInferenceOptions["settings"]["recordInferenceUsage"]): PromptExecutor {
  return {
    appendMessages(messages) {
      executor.appendMessages(messages);
      return this;
    },
    getState: () => executor.getState(),
    getMessages: () => executor.getMessages(),
    clearMessages: () => executor.clearMessages(),
    stream(...args: readonly unknown[]) {
      const result = executor.stream(...args) as Record<string, any>;
      const extendedUsage = result?.extendedUsage as PromiseLike<Record<string, unknown>> | undefined;
      // A provider that reports nothing leaves nothing to write down.
      if (extendedUsage != null && typeof extendedUsage.then === "function") {
        void Promise.resolve(extendedUsage)
          .then((usage) => recordUsage(provider, usageCountsFrom(usage)))
          // A usage that could not be written down is not a reason to fail the turn it belonged to.
          .catch(() => {});
      }
      return result;
    },
  };
}

export function createHostInference(options: HostInferenceOptions) {
  const { auth, experiments, settings } = options;
  // The provider a turn runs on is kept where the coordinator keeps it, not in the host's own settings.
  const routerSettings = new SlateSettingsStore(join(getSlateRootDir(), "settings.json"));
  const cursor = createCursorSlateInference({
    getAccessToken: auth.getAccessToken,
    getMachineId: auth.getMachineId,
    isGeminiVideoDeveloperApiEnabled: () => experiments.checkFeatureGate(GEMINI_VIDEO_DEVELOPER_API_GATE),
    getDefaultModel: () => settings.getAgentDefaultModel(),
    getComputerUseModel: () => {
      const storedModel = settings.getComputerUseModel();
      const overrideModel = experiments.getComputerUseModelOverride();
      return resolveComputerUseModelSelection({ ...(storedModel == null ? {} : { storedModel }), ...(overrideModel == null ? {} : { overrideModel }) });
    },
    getBrowserUseModel: () => experiments.getBrowserUseModelOverride(),
    getModelExperimentState: () => {
      const state = experiments.getSlateModelExperimentState();
      // The state is what a session is shaped by; being able to read it is also the moment the host is told so.
      if (experiments.hasHydratedStatsigUserId()) options.onModelExperimentApplied();
      return state;
    },
    getConfiguredDefaultModel: () => experiments.getConfiguredDefaultModel(),
    getConfiguredAutomationsModel: () => experiments.getConfiguredAutomationsModel(),
  });

  /** A session whose answer is measured: what a routed model spent is written against the provider that spent it. */
  const routedSession = (session: ReturnType<typeof cursor.createSession>, provider: SlateInferenceProvider) => ({
    getModelId: () => session.getModelId(),
    getExecutor: (state?: unknown) => wrapExecutorWithUsageRecording(session.getExecutor(state) as unknown as PromptExecutor, provider, settings.recordInferenceUsage.bind(settings)),
  });

  return {
    ...cursor,
    createSession(onRequestId: (requestId: string) => void, sessionOptions?: Parameters<typeof cursor.createSession>[1]) {
      const provider = routerSettings.getInferenceProvider();
      if (provider === "slate") return routedSession(cursor.createSession(onRequestId, sessionOptions), provider);
      return createProviderPromptSession(provider) as ReturnType<typeof cursor.createSession>;
    },
    createSummarizationSession(onRequestId: (requestId: string) => void, sessionOptions?: Parameters<NonNullable<typeof cursor.createSummarizationSession>>[1]) {
      const provider = routerSettings.getInferenceProvider();
      // A summarization is a session of its own whatever provider runs it.
      if (provider === "slate") return routedSession(cursor.createSession(onRequestId, { ...(sessionOptions ?? {}), isSummarizationSession: true }), provider) as ReturnType<NonNullable<typeof cursor.createSummarizationSession>>;
      return createProviderPromptSession(provider) as ReturnType<NonNullable<typeof cursor.createSummarizationSession>>;
    },
  };
}
