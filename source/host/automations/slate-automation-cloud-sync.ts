/** Keeps Slate's automations reconciled with schedulable cloud copies and reports each failed operation. */
import { ConnectError, Code } from "@connectrpc/connect";
import { buildCloudDefinitionForInterop } from "../../adapters/interop/automation/automation-cloud-definition-adapter.ts";
import { stableAutomationId } from "./automation-id.ts";
import {
  triggerListeners,
  type AutomationTrigger,
} from "../../shared/automations.ts";
import { findSystemErrno } from "../../shared/system-errno.ts";

export const SLATE_SHADOW_MARKER_PREFIX = "slate-shadow:";
const NO_DESIRED_CLOUD_AUTOMATION_IDS = new Set<string>();

export interface ScheduledCloudAutomation {
  readonly id: string;
  readonly name: string;
  readonly prompt: string;
  readonly isEnabled: boolean;
  readonly trigger: AutomationTrigger;
}

export function isServerSchedulable(automation: { readonly trigger: AutomationTrigger }): boolean {
  return !triggerListeners(automation.trigger).some(
    (listener) => listener.type === "slack" && listener.channel.startsWith("@"),
  );
}

function shadowAutomationsOf(listing: RemoteAutomationList): Map<string, RemoteAutomation> {
  return new Map(
    listing.automations
      .filter((automation) => automation.description?.startsWith(SLATE_SHADOW_MARKER_PREFIX))
      .map((automation) => [automation.id, automation] as const),
  );
}

function enabledRemoteAutomationIds(listing: RemoteAutomationList): Set<string> {
  return new Set(listing.automations.filter((automation) => automation.enabled).map((automation) => automation.id));
}

function idsMatch(left: ReadonlySet<string>, right: ReadonlySet<string>): boolean {
  if (left.size !== right.size) return false;
  for (const id of left) if (!right.has(id)) return false;
  return true;
}

function authorityMatches(
  left: SchedulingAuthority | undefined,
  right: SchedulingAuthority,
): boolean {
  return left !== undefined
    && idsMatch(left.wantedAutomationIds, right.wantedAutomationIds)
    && idsMatch(left.enabledRemoteAutomationIds, right.enabledRemoteAutomationIds);
}

function convergedWith(
  upstreamById: ReadonlyMap<string, RemoteAutomation>,
  desiredByAutomationId: ReadonlyMap<string, CloudDefinition>,
): boolean {
  if (upstreamById.size !== desiredByAutomationId.size) return false;
  for (const [automationId, wanted] of desiredByAutomationId) {
    const upstream = upstreamById.get(automationId);
    if (upstream === undefined || upstream.description !== wanted.marker || upstream.enabled !== wanted.enabled) return false;
  }
  return true;
}

function errorShape(error: unknown): { errorType: string; errorCode?: string } {
  const errorType = error instanceof Error ? error.constructor.name : typeof error;
  const errorCode = error instanceof ConnectError ? Code[error.code] : findSystemErrno(error);
  return errorCode === undefined ? { errorType } : { errorType, errorCode };
}

export interface CloudDefinition {
  readonly automationId: string;
  readonly enabled: boolean;
  readonly hash: string;
  readonly localId: string;
  readonly marker: string;
  readonly name: string;
  /** Opaque value encoded by the interop adapter for the remote cloud service. */
  readonly workflow: unknown;
}

export function slateCloudDefinition(args: { agentId: string; automation: ScheduledCloudAutomation; timeZone?: string | undefined }): CloudDefinition | null {
  return buildCloudDefinitionForInterop({
    ...args,
    canScheduleElsewhere: isServerSchedulable(args.automation),
    markerPrefix: SLATE_SHADOW_MARKER_PREFIX,
  });
}

export interface RemoteAutomation {
  readonly id: string;
  readonly description?: string;
  readonly enabled: boolean;
}
export interface RemoteAutomationList { readonly automations: readonly RemoteAutomation[] }
export interface CreateAutomationInput {
  readonly agentId: string;
  readonly automationId: string;
  readonly description: string;
  readonly enabled: boolean;
  readonly name: string;
  readonly workflow: unknown;
}
export interface UpdateAutomationInput {
  readonly id: string;
  readonly description: string;
  readonly enabled: boolean;
  readonly name: string;
  readonly workflow: unknown;
}
export interface CloudSyncClient {
  listAutomationsForAgent(request: { readonly agentId: string }): Promise<RemoteAutomationList>;
  createAutomation(request: CreateAutomationInput): Promise<unknown>;
  updateAutomation(request: UpdateAutomationInput): Promise<unknown>;
  deleteAutomation(request: { readonly id: string }): Promise<unknown>;
}
interface SchedulingEvidence { readonly kind: "known"; readonly enabledRemoteAutomationIds: Set<string> }
interface UnknownSchedulingEvidence { readonly kind: "unknown" }
type AnySchedulingEvidence = SchedulingEvidence | UnknownSchedulingEvidence;
interface SchedulingAuthority { readonly wantedAutomationIds: Set<string>; readonly enabledRemoteAutomationIds: Set<string> }

export class SlateAutomationCloudSync {
  private running: Promise<void> | undefined;
  private rerunRequested = false;
  private readonly fingerprints = new Map<string, string>();
  private readonly evidenceByAgent = new Map<string, AnySchedulingEvidence>();
  private readonly publishedAuthority = new Map<string, SchedulingAuthority>();
  private readonly failedAgentIds = new Set<string>();
  private readonly deletionsToRetry = new Set<string>();
  private timeSettings: { getUserTimeZone: () => string | undefined };

  constructor(private readonly deps: {
    readonly client: CloudSyncClient;
    readonly hasCredential: () => boolean;
    readonly listAgentIds: () => Promise<readonly string[]>;
    readonly listAutomations: () => Promise<readonly { agentId: string; automation: ScheduledCloudAutomation }[]>;
    readonly getTimeZone?: () => string | undefined;
    readonly inspectLocalDefinitions?: (agentId: string) => { state?: string; validDefinitionCount?: number } | undefined;
    readonly reportShadowPrune?: (report: Record<string, unknown>) => void;
    readonly onFailure: (problem: { agentId?: string; operation: string; error: unknown }) => void;
    readonly onRecovery: (agentId: string) => void;
    readonly onSchedulingAuthorityChanged: (agentId: string) => void;
    readonly reportDiagnostic?: (diagnostic: Record<string, unknown>) => void;
  }) {
    this.timeSettings = { getUserTimeZone: deps.getTimeZone ?? (() => undefined) };
  }

  setSettings(timeSettings: { getUserTimeZone: () => string | undefined }): void { this.timeSettings = timeSettings; }

  shouldScheduleLocally({ agentId, automation }: { agentId: string; automation: { readonly id?: string; readonly trigger: AutomationTrigger } }): boolean {
    if (!isServerSchedulable(automation)) return true;
    if (triggerListeners(automation.trigger).length === 0) return false;
    if (automation.id === undefined) return true;
    const evidence = this.evidenceByAgent.get(agentId);
    if (evidence?.kind !== "known") return false;
    return !evidence.enabledRemoteAutomationIds.has(stableAutomationId({ agentId, localId: automation.id }));
  }

  reconcileNow(): Promise<void> {
    if (this.running !== undefined) {
      this.rerunRequested = true;
      return this.running;
    }
    this.running = this.reconcile().catch((error) => { this.reportFailure({ operation: "reconcile", error }); }).finally(() => {
      this.running = undefined;
      if (this.rerunRequested) {
        this.rerunRequested = false;
        void this.reconcileNow();
      }
    });
    return this.running;
  }

  async deleteAgent(agentId: string): Promise<boolean> {
    this.deletionsToRetry.add(agentId);
    const before = await this.fetchRemote(agentId);
    if (before === undefined) return false;
    const remoteAutomations = before.automations;
    if (remoteAutomations.length === 0) {
      this.publishEvidence(agentId, before, NO_DESIRED_CLOUD_AUTOMATION_IDS);
      this.completeDeletion(agentId);
      return true;
    }
    let someMutationFailed = false;
    for (const automation of remoteAutomations) {
      const worked = await this.attemptMutation(agentId, "delete", () => this.deps.client.deleteAutomation({ id: automation.id }));
      someMutationFailed ||= !worked;
    }
    const after = await this.fetchRemote(agentId);
    if (after === undefined) return false;
    this.publishEvidence(agentId, after, NO_DESIRED_CLOUD_AUTOMATION_IDS);
    if (after.automations.length > 0) {
      if (!someMutationFailed) this.reportFailure({ agentId, operation: "verify", error: new Error("Remote automation deletion did not converge") });
      return false;
    }
    this.completeDeletion(agentId);
    return true;
  }

  private async retryDeletions(): Promise<void> {
    for (const agentId of [...this.deletionsToRetry]) await this.deleteAgent(agentId);
  }

  private async reconcile(): Promise<void> {
    if (!this.deps.hasCredential()) return;
    await this.retryDeletions();
    let listedAutomations: readonly { agentId: string; automation: ScheduledCloudAutomation }[];
    try { listedAutomations = await this.deps.listAutomations(); } catch (error) { this.reportFailure({ operation: "list-local", error }); return; }
    let listedAgents: readonly string[];
    try { listedAgents = await this.deps.listAgentIds(); } catch (error) { this.reportFailure({ operation: "list-agents", error }); return; }
    const agentIds = new Set(listedAgents);
    const desiredByAgent = new Map<string, Map<string, CloudDefinition>>();
    const timeZone = this.timeSettings.getUserTimeZone();
    for (const { agentId, automation } of listedAutomations) {
      agentIds.add(agentId);
      const wanted = slateCloudDefinition({ agentId, automation, timeZone });
      if (wanted === null) continue;
      const wantedById = desiredByAgent.get(agentId) ?? new Map<string, CloudDefinition>();
      wantedById.set(wanted.automationId, wanted);
      desiredByAgent.set(agentId, wantedById);
    }
    for (const agentId of agentIds) {
      const wanted = desiredByAgent.get(agentId) ?? new Map<string, CloudDefinition>();
      const stamp = [...wanted.values()].sort((a, b) => a.automationId.localeCompare(b.automationId)).map((definition) => `${definition.automationId}:${definition.marker}`).join("\0");
      if (this.fingerprints.get(agentId) === stamp) continue;
      try {
        if (await this.reconcileOne(agentId, wanted)) this.fingerprints.set(agentId, stamp);
      } catch (error) { this.reportFailure({ agentId, operation: "reconcile", error }); }
    }
  }

  private async reconcileOne(agentId: string, desiredByAutomationId: Map<string, CloudDefinition>): Promise<boolean> {
    const wantedAutomationIds = new Set(desiredByAutomationId.keys());
    const before = await this.fetchRemote(agentId);
    if (before === undefined) return false;
    const upstreamById = shadowAutomationsOf(before);
    if (convergedWith(upstreamById, desiredByAutomationId)) {
      this.publishEvidence(agentId, before, wantedAutomationIds);
      this.reportRecovery(agentId);
      return true;
    }
    let someMutationFailed = false;
    const localState = this.deps.inspectLocalDefinitions?.(agentId);
    for (const [automationId, upstream] of upstreamById) {
      if (desiredByAutomationId.has(automationId)) continue;
      const worked = await this.attemptMutation(agentId, "delete", () => this.deps.client.deleteAutomation({ id: upstream.id }));
      someMutationFailed ||= !worked;
      this.deps.reportShadowPrune?.({ conversationId: agentId, automationId, outcome: worked ? "deleted" : "failed", localDefinitionState: localState?.state ?? "unknown", localDefinitionCount: localState?.validDefinitionCount ?? desiredByAutomationId.size, desiredCount: desiredByAutomationId.size, remoteShadowCount: upstreamById.size });
    }
    for (const [automationId, wanted] of desiredByAutomationId) {
      const upstream = upstreamById.get(automationId);
      if (upstream === undefined) {
        const worked = await this.attemptMutation(agentId, "create", () => this.deps.client.createAutomation({ description: wanted.marker, name: wanted.name, workflow: wanted.workflow, enabled: wanted.enabled, agentId, automationId }));
        someMutationFailed ||= !worked;
      } else if (upstream.description !== wanted.marker || upstream.enabled !== wanted.enabled) {
        const worked = await this.attemptMutation(agentId, "update", () => this.update(upstream.id, wanted));
        someMutationFailed ||= !worked;
      }
    }
    const after = await this.fetchRemote(agentId);
    if (after === undefined) return false;
    this.publishEvidence(agentId, after, wantedAutomationIds);
    const matches = convergedWith(shadowAutomationsOf(after), desiredByAutomationId);
    if (!matches) {
      if (!someMutationFailed) this.reportFailure({ agentId, operation: "verify", error: new Error("Remote automation reconciliation did not converge") });
      return false;
    }
    this.reportRecovery(agentId);
    return true;
  }

  private async update(automationId: string, wanted: CloudDefinition): Promise<void> {
    await this.deps.client.updateAutomation({ id: automationId, description: wanted.marker, name: wanted.name, workflow: wanted.workflow, enabled: wanted.enabled });
  }

  private async fetchRemote(agentId: string): Promise<RemoteAutomationList | undefined> {
    try { return await this.deps.client.listAutomationsForAgent({ agentId }); }
    catch (error) { this.reportFailure({ agentId, operation: "list-remote", error }); return undefined; }
  }

  private async attemptMutation(agentId: string, operation: string, work: () => Promise<unknown>): Promise<boolean> {
    this.evidenceByAgent.set(agentId, { kind: "unknown" });
    try { await work(); return true; }
    catch (error) { this.reportFailure({ agentId, operation, error }); return false; }
  }

  private publishEvidence(agentId: string, listing: RemoteAutomationList, wantedAutomationIds: Set<string>): void {
    const enabledRemoteIds = enabledRemoteAutomationIds(listing);
    this.evidenceByAgent.set(agentId, { kind: "known", enabledRemoteAutomationIds: enabledRemoteIds });
    const schedulingAuthority = { wantedAutomationIds, enabledRemoteAutomationIds: enabledRemoteIds };
    const lastPublished = this.publishedAuthority.get(agentId);
    if (authorityMatches(lastPublished, schedulingAuthority)) return;
    this.publishedAuthority.set(agentId, schedulingAuthority);
    try { this.deps.onSchedulingAuthorityChanged(agentId); }
    catch (error) { this.reportCallbackError("onSchedulingAuthorityChanged", agentId, error); }
  }

  private reportFailure(problem: { agentId?: string; operation: string; error: unknown }): void {
    if (problem.agentId !== undefined) this.failedAgentIds.add(problem.agentId);
    this.deps.reportDiagnostic?.({ extension: "automation_cloud_sync", operation: problem.operation, agentId: problem.agentId, ...errorShape(problem.error) });
    if (!this.deps.hasCredential()) return;
    try { this.deps.onFailure(problem); }
    catch (error) { this.reportCallbackError("onFailure", problem.agentId, error); }
  }

  private reportRecovery(agentId: string): void {
    if (!this.failedAgentIds.delete(agentId)) return;
    try { this.deps.onRecovery(agentId); }
    catch (error) { this.reportCallbackError("onRecovery", agentId, error); }
  }

  private completeDeletion(agentId: string): void {
    this.deletionsToRetry.delete(agentId);
    this.fingerprints.delete(agentId);
    this.reportRecovery(agentId);
    this.evidenceByAgent.delete(agentId);
    this.publishedAuthority.delete(agentId);
  }

  private reportCallbackError(callback: string, agentId: string | undefined, error: unknown): void {
    this.deps.reportDiagnostic?.({ extension: "automation_cloud_sync", operation: callback, agentId, ...errorShape(error) });
  }
}
