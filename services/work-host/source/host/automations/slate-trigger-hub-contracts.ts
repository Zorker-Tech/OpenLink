import type { PollingPolicy } from "../extensions/scheduling.ts";
import type { AutomationTrigger, EventTrigger } from "../../shared/automations.ts";

export interface TriggerSourceStatus {
  state: string;
  detail?: string;
  scopeIssues?: readonly unknown[];
}

export interface TriggerSource {
  kind: string;
  setListeners(listeners: readonly EventTrigger[]): void;
  start(accept: (event: Record<string, unknown>) => boolean): Promise<void>;
  stop(): Promise<void>;
  getStatus(): TriggerSourceStatus;
}

export interface ScheduledAutomation {
  agentId: string;
  automation: { id?: string; isEnabled: boolean; trigger: AutomationTrigger };
}

export interface SlateTriggerHubDependencies {
  polling: PollingPolicy;
  sources: readonly TriggerSource[];
  listAutomations(): Promise<readonly ScheduledAutomation[]>;
  fire(agentId: string, automation: ScheduledAutomation["automation"], event: Record<string, unknown>): Promise<unknown>;
  isReady(): boolean | Promise<boolean>;
  shouldScheduleLocally?(agentId: string, automation: ScheduledAutomation["automation"]): boolean;
  onReconcile?(): void;
}
