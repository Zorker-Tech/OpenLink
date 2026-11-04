/**
 * Reporting which model-experiment arm a turn was exposed to.
 *
 * What is reported waits until the experiment's statistics have hydrated, and is only reported once per conversation
 * and arm, so an exposure is counted once however many turns follow it.
 */
import { readSlateModelExperimentEnvOverride } from "../../shared/node/experiments/slate-model-experiment.ts";
export const HYDRATION_WAIT_MS = 60_000;
export interface ModelExperimentExposureDeps {
  experiments: {
    hasHydratedExperimentUser(): boolean;
    waitForHydratedExperimentUser(timeoutMs: number): Promise<boolean>;
    getSlateModelExperimentState():
      { active: boolean; arm: string } | null | undefined;
    logSlateModelExperimentExposure(): boolean;
  };
  analytics: {
    canRecordEvents(): boolean;
    trackEvent(name: string, properties: { arm: string }): void;
  };
  env?: NodeJS.ProcessEnv;
}
export function createModelExperimentExposureLatch(
  deps: ModelExperimentExposureDeps,
) {
  let exposureRecorded = false;
  let pendingHydrationWait: Promise<boolean> | undefined;

  async function waitForAssignment(): Promise<boolean> {
    const wait = pendingHydrationWait ??= deps.experiments.waitForHydratedExperimentUser(HYDRATION_WAIT_MS);
    try {
      return await wait;
    } finally {
      if (pendingHydrationWait === wait) pendingHydrationWait = undefined;
    }
  }

  function trackExposure(arm: string): void {
    if (!deps.analytics.canRecordEvents()) return;
    deps.analytics.trackEvent("slate.model_experiment.exposure", { arm });
  }

  async function attemptExposure(): Promise<void> {
    if (exposureRecorded) return;

    const override = readSlateModelExperimentEnvOverride(deps.env ?? process.env);
    if (override === undefined && !deps.experiments.hasHydratedExperimentUser()) {
      const ready = await waitForAssignment();
      if (exposureRecorded || !ready) return;
    }

    const assignment = override ?? deps.experiments.getSlateModelExperimentState();
    if (assignment == null || !assignment.active) return;

    const acceptedByExperiments = deps.experiments.logSlateModelExperimentExposure();
    if (!acceptedByExperiments && (override === undefined || !deps.analytics.canRecordEvents())) return;

    exposureRecorded = true;
    trackExposure(assignment.arm);
  }

  return {
    note: () => {
      if (!exposureRecorded) void attemptExposure();
    },
  };
}
