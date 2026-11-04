export { SlateExperimentService } from "./slate-experiment-service-engine.ts";
export {
  BASE_POLL_INTERVAL_MS,
  BOOTSTRAP_TIMEOUT_MS,
  GATE_READY_TIMEOUT_MS,
  MIN_POLL_INTERVAL_MS,
  POLL_JITTER_FRACTION,
  computePollDelayMs,
  envGateOverride,
  jitteredSlateExperimentPollIntervalMs,
} from "./slate-experiment-policies.ts";
export type { ExperimentSnapshot, RefreshTrigger } from "./slate-experiment-contracts.ts";
