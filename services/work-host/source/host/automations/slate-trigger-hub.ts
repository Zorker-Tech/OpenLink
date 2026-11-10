import { SlateTriggerHubEngine } from "./slate-trigger-hub-engine.ts";

export type {
  ScheduledAutomation,
  SlateTriggerHubDependencies,
  TriggerSource,
  TriggerSourceStatus,
} from "./slate-trigger-hub-contracts.ts";

export class SlateTriggerHub extends SlateTriggerHubEngine {}
