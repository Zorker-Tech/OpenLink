/** Taking the fires the backend raises for this box's automations.

 * The backend is polled for fires, each one is checked against what the box actually has — the automation, its enabled
 * fireState, its definition, the event it carried — and what is run is answered for when it finishes, with the fires that
 * were refused and the polling that failed both reported. */
import { GITHUB_EVENT_KINDS, triggerCronSchedules, triggerEventTriggers, type AutomationTrigger } from "../../shared/automations.ts";
import { stableAutomationId } from "./automation-id.ts";
import { createNotifyDrainGate } from "../notifications/notify-drain-gate.ts";
import { triggerMatchesEvent } from "./automation-trigger.ts";
import { brandedErrno } from "../../shared/errors/bounded-values.ts";
import { SlateError } from "../../shared/errors/registry.ts";
import { findSystemErrno } from "../../shared/system-errno.ts";
import { getSlateBackendClientHeaders } from "../../adapters/interop/backend/slate-client-metadata-adapter.ts";
import { createNoopSlateTelemetry, slateErrorDetail } from "../ports/telemetry.ts";
import { isServerSchedulable, slateCloudDefinition, type ScheduledCloudAutomation } from "./slate-automation-cloud-sync.ts";
export const ERROR_BACKOFF_MS = 30_000, MAX_NEXT_POLL_DELAY_MS = 60_000, MAX_REPORTED_REJECTED_FIRES = 256;
const ID_MAX = 200, TEXT_MAX = 4_000, TITLE_MAX = 400, URL_MAX = 600, STATUS_MAX = 200;
const isObjectValue = (value: unknown): value is Record<string, unknown> => typeof value === "object" && value != null && !Array.isArray(value);
function cappedText(value: unknown, max: number): string | undefined { return typeof value === "string" && value.length > 0 && value.length <= max ? value : undefined; }
function anyFieldOversized(value: Record<string, unknown>, fields: readonly [string, number][]): boolean { return fields.some(([name, max]) => typeof value[name] === "string" && value[name].length > max); }
export function parseFireTriggerEvent(value: unknown): Record<string, unknown> | null {
  if (!isObjectValue(value)) return null;
  const timestampMs = typeof value.timestampMs === "number" ? value.timestampMs : Date.now();
  switch (value.source) {
    case "slack": return parseSlackEvent(value, timestampMs);
    case "github": return parseGithubEvent(value, timestampMs);
    case "microsoftTeams": return parseTeamsEvent(value, timestampMs);
    case "linear": return parseLinearEvent(value, timestampMs);
    case "sentry": return parseSentryEvent(value, timestampMs);
    case "pagerduty": return parsePagerDutyEvent(value, timestampMs);
    default: return null;
  }
}
function parseSlackEvent(value: Record<string, unknown>, timestampMs: number): Record<string, unknown> | null { if (typeof value.channel !== "string" || value.channel.length === 0) return null; return { source: "slack", channel: value.channel, sender: typeof value.sender === "string" ? value.sender : "someone", text: typeof value.text === "string" ? value.text : "", isMention: value.isMention === true, ...(value.isSelf === true ? { isSelf: true } : {}), ...(typeof value.reactionEmoji === "string" && value.reactionEmoji.length > 0 ? { reactionEmoji: value.reactionEmoji } : {}), ...(typeof value.ts === "string" && value.ts.length > 0 ? { ts: value.ts } : {}), ...(typeof value.threadTs === "string" && value.threadTs.length > 0 ? { threadTs: value.threadTs } : {}), timestampMs }; }
function parseGithubEvent(value: Record<string, unknown>, timestampMs: number): Record<string, unknown> | null { if (typeof value.repo !== "string" || value.repo.length === 0 || typeof value.kind !== "string" || !(GITHUB_EVENT_KINDS as readonly string[]).includes(value.kind)) return null; return { source: "github", repo: value.repo, kind: value.kind, title: typeof value.title === "string" ? value.title : "", actor: typeof value.actor === "string" ? value.actor : "someone", ...(typeof value.url === "string" && value.url.length > 0 ? { url: value.url } : {}), ...(typeof value.detail === "string" && value.detail.length > 0 ? { detail: value.detail } : {}), ...(typeof value.prOwner === "string" && value.prOwner.length > 0 ? { prOwner: value.prOwner } : {}), ...(typeof value.branch === "string" && value.branch.length > 0 ? { branch: value.branch } : {}), timestampMs }; }
function parseTeamsEvent(value: Record<string, unknown>, timestampMs: number): Record<string, unknown> | null { if (anyFieldOversized(value, [["tenantId",ID_MAX],["teamId",ID_MAX],["channelId",ID_MAX],["text",TEXT_MAX],["aadObjectId",ID_MAX],["activityId",ID_MAX],["rootMessageId",ID_MAX]])) return null; const tenantId = cappedText(value.tenantId, ID_MAX), teamId = cappedText(value.teamId, ID_MAX), channelId = cappedText(value.channelId, ID_MAX); if (tenantId == null || teamId == null || channelId == null) return null; return { source: "microsoftTeams", tenantId, teamId, channelId, text: typeof value.text === "string" ? value.text : "", aadObjectId: cappedText(value.aadObjectId, ID_MAX) ?? "unknown", activityId: cappedText(value.activityId, ID_MAX) ?? "unknown", ...(cappedText(value.rootMessageId, ID_MAX) == null ? {} : { rootMessageId: value.rootMessageId }), timestampMs }; }
function parseLinearEvent(value: Record<string, unknown>, timestampMs: number): Record<string, unknown> | null { if (!["issueCreated","statusChanged","endOfCycle"].includes(String(value.event)) || anyFieldOversized(value, [["issueIdentifier",ID_MAX],["title",TITLE_MAX],["url",URL_MAX],["status",STATUS_MAX],["projectId",ID_MAX],["teamId",ID_MAX],["statusId",ID_MAX],["cycleId",ID_MAX],["cycleName",TITLE_MAX]])) return null; const pollResult: Record<string, unknown> = { source: "linear", event: value.event, timestampMs }; for (const [name,max] of [["issueIdentifier",ID_MAX],["title",TITLE_MAX],["url",URL_MAX],["status",STATUS_MAX],["projectId",ID_MAX],["teamId",ID_MAX],["statusId",ID_MAX],["cycleId",ID_MAX],["cycleName",TITLE_MAX]] as const) { const field = cappedText(value[name], max); if (field != null) pollResult[name] = field; } return pollResult; }
function parseSentryEvent(value: Record<string, unknown>, timestampMs: number): Record<string, unknown> | null { if (!["issueCreated","issueResolved","issueAssigned","issueArchived","issueUnresolved"].includes(String(value.event)) || anyFieldOversized(value, [["issueId",ID_MAX],["shortId",ID_MAX],["title",TITLE_MAX],["projectId",ID_MAX],["url",URL_MAX],["projectSlug",ID_MAX],["status",STATUS_MAX],["substatus",STATUS_MAX]])) return null; const issueId = cappedText(value.issueId, ID_MAX), shortId = cappedText(value.shortId, ID_MAX), title = cappedText(value.title, TITLE_MAX); if (issueId == null || shortId == null || title == null) return null; return { source: "sentry", event: value.event, issueId, shortId, title, ...(cappedText(value.projectId,ID_MAX) == null ? {} : { projectId: value.projectId }), ...(cappedText(value.url,URL_MAX) == null ? {} : { url: value.url }), ...(cappedText(value.projectSlug,ID_MAX) == null ? {} : { projectSlug: value.projectSlug }), ...(cappedText(value.status,STATUS_MAX) == null ? {} : { status: value.status }), ...(cappedText(value.substatus,STATUS_MAX) == null ? {} : { substatus: value.substatus }), timestampMs }; }
function parsePagerDutyEvent(value: Record<string, unknown>, timestampMs: number): Record<string, unknown> | null { if (!["incidentTriggered","incidentAcknowledged","incidentResolved","incidentEscalated"].includes(String(value.event)) || anyFieldOversized(value, [["incidentId",ID_MAX],["title",TITLE_MAX],["status",STATUS_MAX],["serviceId",ID_MAX],["serviceName",ID_MAX],["url",URL_MAX]])) return null; const incidentId = cappedText(value.incidentId,ID_MAX), title = cappedText(value.title,TITLE_MAX), status = cappedText(value.status,STATUS_MAX), serviceId = cappedText(value.serviceId,ID_MAX); if (incidentId == null || title == null || status == null || serviceId == null) return null; return { source: "pagerduty", event: value.event, incidentId, title, status, serviceId, ...(cappedText(value.serviceName,ID_MAX) == null ? {} : { serviceName: value.serviceName }), ...(cappedText(value.url,URL_MAX) == null ? {} : { url: value.url }), timestampMs }; }


export function admitsBareFire(trigger: AutomationTrigger, event: { scheduledForMs?: number }): boolean { const cron = triggerCronSchedules(trigger); return cron.length > 0 && (triggerEventTriggers(trigger).length === 0 || event.scheduledForMs !== undefined); }
export function fireEventMatchesTrigger(trigger: AutomationTrigger, normalizedEvent: Record<string, unknown>, rawWireEvent: unknown): boolean { const triggerMatchOptions = { admitMissingSubject: true, platformMatched: true }; if (triggerMatchesEvent(trigger, normalizedEvent, triggerMatchOptions)) return true; if (normalizedEvent.source !== "slack" || !isObjectValue(rawWireEvent)) return false; const channelId = cappedText(rawWireEvent.channelId, ID_MAX); return channelId != null && channelId !== normalizedEvent.channel && triggerMatchesEvent(trigger, { ...normalizedEvent, channel: channelId }, triggerMatchOptions); }
type Completion = { readonly phase: "completed"; readonly status: "succeeded" | "failed"; readonly errorMessage?: string };
export function completionOfOutcome(fireOutcome: string): Completion { return fireOutcome === "ok" ? { phase: "completed", status: "succeeded" } : { phase: "completed", status: "failed", errorMessage: fireOutcome === "interrupted" ? "Automation run was interrupted by a Slate host update; the box resumes it locally" : "Automation run failed on the Slate box" }; }
export class BackendStatusError extends Error { constructor(path: string, readonly status: number) { super(`slate automation relay ${path} returned ${status}`); } }
type DeliveryError = ReturnType<typeof SlateError.backendHttpStatus> | ReturnType<typeof SlateError.backendUnreachable> | ReturnType<typeof SlateError.backendDeliveryFailed>;
function classifyDeliveryError(error: unknown): DeliveryError { if (error instanceof BackendStatusError) return SlateError.backendHttpStatus({ httpStatus: error.status }); const errno = findSystemErrno(error); if (errno !== undefined) return SlateError.backendUnreachable({ errno: brandedErrno(errno) }); return SlateError.backendDeliveryFailed(); }
function coarseDeliveryErrorTypeAndCode(error: unknown): { errorType: string; errorCode?: string } { const errorCode = error instanceof BackendStatusError ? String(error.status) : findSystemErrno(error); return { errorType: error instanceof Error ? error.constructor.name : typeof error, ...(errorCode == null ? {} : { errorCode }) }; }
interface FireWire { readonly id: string; readonly slateAgentId: string; readonly automationId: string; readonly timestampMs: number; readonly definitionRevision?: string; readonly scheduledForMs?: number; readonly event?: unknown }
interface FireTarget { readonly agentId: string; readonly automation: ScheduledCloudAutomation & { readonly lastRunAt?: number | null; readonly runs?: readonly { id: string; coalescedRunIds?: readonly string[]; status: string; detail?: string }[] } }
export class SlateAutomationFireConsumer {
  private readonly fetchImpl: typeof fetch;
  /** What a poll reports to. A reporter the caller did not have is not one this consumer may insist on. */
  private readonly telemetry: { reportAutomationFireDropped(value: Record<string, unknown>): void; reportAgentError?(value: Record<string, unknown>): void };
  private pollRunning = false;
  private stoppedNow = false;
  private retryAfter = 0;
  private pollAfter = 0;
  private drainedUnschedulable = false;
  private readonly runStates = new Map<string, Completion | { phase: "running" | "reported" }>();
  private readonly droppedRunIds = new Set<string>();
  private readonly drainGate;

  constructor(private readonly deps: {
    readonly getAccessToken: (args: { backendUrl: string }) => Promise<string>;
    readonly getBackendUrl: () => string;
    readonly getTimeZone: () => string | undefined;
    readonly getBoxUptimeMs: () => number | undefined;
    readonly isReady: () => boolean | Promise<boolean>;
    readonly listAutomations: () => Promise<readonly FireTarget[]>;
    readonly fire: (args: { agentId: string; automation: FireTarget["automation"]; runUuid: string; scheduledForMs?: number }) => Promise<string | undefined>;
    readonly fireForEvent: (args: { agentId: string; automation: FireTarget["automation"]; event: Record<string, unknown>; runUuid: string }) => Promise<string | undefined>;
    readonly fetchImpl?: typeof fetch;
    readonly telemetry?: { reportAutomationFireDropped(value: Record<string, unknown>): void; reportAgentError?(value: Record<string, unknown>): void };
    readonly isNotifyConnected?: () => boolean;
    readonly isNotifySafetyPollEnabled?: () => boolean;
  }) {
    this.fetchImpl = deps.fetchImpl ?? fetch;
    this.telemetry = deps.telemetry ?? createNoopSlateTelemetry();
    this.drainGate = createNotifyDrainGate({ isConnected: () => deps.isNotifyConnected?.() ?? false, isSafetyPollEnabled: () => deps.isNotifySafetyPollEnabled?.() ?? true, now: Date.now });
  }

  start(): void { this.stoppedNow = false; this.drainedUnschedulable = false; this.drainGate.reset(); }
  stop(): void { this.stoppedNow = true; this.retryAfter = 0; this.pollAfter = 0; }
  resetPollDelay(): void { this.pollAfter = 0; }
  requestDrain(): void { this.drainGate.recordNotify(); this.pollAfter = 0; void this.tick(); }

  async tick(): Promise<void> {
    if (this.pollRunning || this.stoppedNow || Date.now() < this.retryAfter) return;
    this.pollRunning = true;
    try {
      if (!await this.deps.isReady()) return;
      let schedulableSeen: boolean | undefined;
      if (this.runStates.size === 0) {
        if (Date.now() < this.pollAfter || !this.drainGate.shouldDrain({ hasOwedWork: false })) return;
        schedulableSeen = (await this.deps.listAutomations()).some(({ automation }) => isServerSchedulable(automation));
        if (!schedulableSeen && this.drainedUnschedulable) return;
      }
      const ackIds = [...this.runStates].filter(([, fireState]) => fireState.phase === "reported").map(([id]) => id);
      const pollResult = await this.postJson("/slate/automation-events/poll", { ackRunUuids: ackIds }) as { events?: FireWire[]; nextPollAfterMs?: number };
      const polledFires = pollResult.events ?? [];
      this.drainGate.recordPoll();
      if (schedulableSeen !== undefined) this.drainedUnschedulable = !schedulableSeen;
      const returnedIds = new Set(polledFires.map(({ id }) => id));
      for (const [id, fireState] of this.runStates) if (fireState.phase === "reported" && !returnedIds.has(id)) this.runStates.delete(id);
      for (const event of polledFires) if (!this.runStates.has(event.id)) { this.runStates.set(event.id, { phase: "running" }); void this.deliverFire(event); }
      for (const [id, fireState] of this.runStates) if (fireState.phase === "completed") await this.reportCompletion(id, fireState);
      this.pollAfter = polledFires.length === 0 && this.runStates.size === 0 && typeof pollResult.nextPollAfterMs === "number" && Number.isFinite(pollResult.nextPollAfterMs) && pollResult.nextPollAfterMs > 0 ? Date.now() + Math.min(pollResult.nextPollAfterMs, MAX_NEXT_POLL_DELAY_MS) : 0;
    } catch (error) {
      this.retryAfter = Date.now() + ERROR_BACKOFF_MS;
      this.telemetry.reportAgentError?.({ source: "automation_fire_poll", error: classifyDeliveryError(error), detail: slateErrorDetail(error) });
    } finally { this.pollRunning = false; }
  }

  private existingCompletionFor(fireTarget: FireTarget["automation"], id: string): Completion | undefined {
    const run = fireTarget.runs?.find((candidateRun) => candidateRun.id === id || candidateRun.coalescedRunIds?.includes(id) === true);
    if (run === undefined || run.status === "running") return undefined;
    return run.status === "ok" ? { phase: "completed", status: "succeeded" } : { phase: "completed", status: "failed", ...(run.detail === undefined ? {} : { errorMessage: run.detail }) };
  }

  private async deliverFire(event: FireWire): Promise<void> {
    let completed: Completion | undefined;
    try {
      const fireTarget = (await this.deps.listAutomations()).find((entry) => entry.agentId === event.slateAgentId && stableAutomationId({ agentId: entry.agentId, localId: entry.automation.id }) === event.automationId);
      if (this.stoppedNow) { this.runStates.delete(event.id); return; }
      const existingRunCompletion = fireTarget === undefined ? undefined : this.existingCompletionFor(fireTarget.automation, event.id);
      if (fireTarget === undefined) completed = this.reject(event, "automation_missing", "Automation not found on the Slate box");
      else if (existingRunCompletion !== undefined) completed = existingRunCompletion;
      else if (!fireTarget.automation.isEnabled) completed = this.reject(event, "automation_disabled", "Automation is disabled on the Slate box");
      else if (event.definitionRevision === undefined && event.event == null && admitsBareFire(fireTarget.automation.trigger, event) && fireTarget.automation.lastRunAt !== null && fireTarget.automation.lastRunAt !== undefined && fireTarget.automation.lastRunAt >= event.timestampMs) completed = this.reject(event, "slot_already_covered", "Legacy automation fire was already covered on the Slate box");
      else if (event.definitionRevision !== undefined && slateCloudDefinition({ agentId: fireTarget.agentId, automation: fireTarget.automation, timeZone: this.deps.getTimeZone() })?.hash !== event.definitionRevision) completed = this.reject(event, "definition_changed", "Automation definition changed on the Slate box");
      else if (event.event != null) {
        const normalizedEvent = parseFireTriggerEvent(event.event);
        if (normalizedEvent === null) completed = this.reject(event, "event_unrecognized", "Event context not recognized by the Slate box");
        else if (!fireEventMatchesTrigger(fireTarget.automation.trigger, normalizedEvent, event.event)) completed = this.reject(event, "trigger_no_longer_matches", "Automation trigger no longer matches the event");
        else {
          const fireOutcome = await this.deps.fireForEvent({ agentId: fireTarget.agentId, automation: fireTarget.automation, event: normalizedEvent, runUuid: event.id });
          if (fireOutcome === undefined) { this.runStates.delete(event.id); return; }
          completed = completionOfOutcome(fireOutcome);
        }
      } else if (!admitsBareFire(fireTarget.automation.trigger, event)) completed = this.reject(event, "missing_event_context", "Fire carried no event context on the Slate box", "event");
      else {
        const fireOutcome = await this.deps.fire({ agentId: fireTarget.agentId, automation: fireTarget.automation, runUuid: event.id, ...(event.scheduledForMs === undefined ? {} : { scheduledForMs: event.scheduledForMs }) });
        if (fireOutcome === undefined) { this.runStates.delete(event.id); return; }
        completed = completionOfOutcome(fireOutcome);
      }
    } catch (error) {
      this.runStates.delete(event.id);
      this.reportRejected(event, "delivery_error", error);
      return;
    }
    this.runStates.set(event.id, completed!);
    await this.reportCompletion(event.id, completed!);
  }

  private reject(event: FireWire, reason: string, errorMessage: string, trigger?: "event" | "schedule"): Completion { this.reportRejected(event, reason, undefined, trigger); return { phase: "completed", status: "failed", errorMessage }; }

  private reportRejected(event: FireWire, reason: string, error?: unknown, trigger: "event" | "schedule" = event.event != null ? "event" : "schedule"): void {
    if (this.droppedRunIds.has(event.id)) return;
    this.droppedRunIds.add(event.id);
    while (this.droppedRunIds.size > MAX_REPORTED_REJECTED_FIRES) {
      const oldest = this.droppedRunIds.values().next().value as string | undefined;
      if (oldest === undefined) break;
      this.droppedRunIds.delete(oldest);
    }
    const boxUptimeMs = this.deps.getBoxUptimeMs();
    this.telemetry.reportAutomationFireDropped({ conversationId: event.slateAgentId, trigger, reason, ...(event.scheduledForMs == null ? {} : { scheduledForMs: event.scheduledForMs, latenessMs: Math.max(0, Date.now() - event.scheduledForMs) }), runUuid: event.id, fireAgeMs: Math.max(0, Date.now() - event.timestampMs), hasDefinitionRevision: event.definitionRevision !== undefined, ...(boxUptimeMs === undefined ? {} : { boxUptimeMs }), ...(error === undefined ? {} : coarseDeliveryErrorTypeAndCode(error)) });
  }

  private async reportCompletion(id: string, completed: Completion): Promise<void> { try { await this.postJson("/slate/automation-runs/complete", { runUuid: id, status: completed.status, errorMessage: completed.errorMessage }); this.runStates.set(id, { phase: "reported" }); } catch (error) { if (error instanceof BackendStatusError && (error.status === 409 || error.status === 404)) this.runStates.set(id, { phase: "reported" }); } }
  private async postJson(path: string, body: unknown): Promise<unknown> { const backendUrl = this.deps.getBackendUrl(), token = await this.deps.getAccessToken({ backendUrl }), response = await this.fetchImpl(new URL(path, backendUrl).toString(), { method: "POST", headers: { "content-type": "application/json", authorization: `Bearer ${token}`, ...getSlateBackendClientHeaders() }, body: JSON.stringify(body) }); if (!response.ok) throw new BackendStatusError(path, response.status); return await response.json(); }
}
