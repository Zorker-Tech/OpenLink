/**
 * The auto-review an agent can be put under.
 *
 * A review is asked for with what to look at, is approved or refused within a bounded time, and only so many of them
 * may be waiting for one agent at a time; what was decided is remembered so the same review is not asked twice.
 */
import { createHash, randomUUID } from "node:crypto";

export const SLATE_AUTO_REVIEW_APPROVAL_TTL_MS = 10 * 60 * 1_000;
export const SLATE_AUTO_REVIEW_MAX_PENDING_PER_AGENT = 4;
export const SLATE_AUTO_REVIEW_HOST_GENERATION = randomUUID();

export type SlateAutoReviewMode = "off" | "shadow" | "enforce";
export type SlateAutoReviewSurface = "hostShell" | "boxShell" | "mcp" | "computer" | "automationWrite" | "cloudAgent" | "subagentLaunch" | string;
export type SlateAutoReviewResolution = "approved" | "denied";
export type SlateAutoReviewExpiryCause = "ttl" | "cancelled" | "user_redirect" | "settings_change" | "session_end" | "quiesce" | string;
export type SlateAutoReviewExpiryPolicy = "park" | "ttl";

export interface SlateAutoReviewModes {
  readonly hostShell: SlateAutoReviewMode;
  readonly boxShell: SlateAutoReviewMode;
  readonly mcp: SlateAutoReviewMode;
  readonly computer: SlateAutoReviewMode;
  readonly automationWrite: "off";
  readonly cloudAgent: SlateAutoReviewMode;
  readonly subagentLaunch: SlateAutoReviewMode;
}

export interface SlateAutoReviewApproval {
  readonly id: string;
  readonly agentId: string;
  readonly surface: SlateAutoReviewSurface;
  readonly fingerprint: string;
  readonly reason: string;
  readonly summary: string;
  readonly command?: string;
  readonly proposedRule?: string;
  readonly userMessageEpoch: number;
  readonly hostGeneration: string;
  readonly createdAtMs: number;
  readonly expiresAtMs?: number;
  readonly status: "pending" | SlateAutoReviewResolution | "expired";
}

export type SlateAutoReviewEvent =
  | { readonly type: "created" | "resolved"; readonly approval: SlateAutoReviewApproval }
  | { readonly type: "expired"; readonly approval: SlateAutoReviewApproval; readonly cause: SlateAutoReviewExpiryCause };

export interface SlateAutoReviewRequest {
  readonly agentId?: string;
  readonly surface: SlateAutoReviewSurface;
  readonly fingerprint: string;
  readonly reason: string;
  readonly summary: string;
  readonly command?: string;
  readonly proposedRule?: string;
  readonly expiryPolicy?: SlateAutoReviewExpiryPolicy;
  readonly signal?: AbortSignal;
}

export type SlateAutoReviewDecision = { readonly approved: true } | { readonly approved: false; readonly reason: string };

export function slateAutoReviewApprovalExpiryPolicy(source: string): SlateAutoReviewExpiryPolicy {
  return source === "turn" || source === "handoff-resume" ? "park" : "ttl";
}

export const SLATE_AUTO_REVIEW_MODES_OFF: SlateAutoReviewModes = Object.freeze({ hostShell: "off", boxShell: "off", mcp: "off", computer: "off", automationWrite: "off", cloudAgent: "off", subagentLaunch: "off" });
export const SLATE_AUTO_REVIEW_MODES_SHADOW: SlateAutoReviewModes = Object.freeze({ hostShell: "shadow", boxShell: "shadow", mcp: "shadow", computer: "shadow", automationWrite: "off", cloudAgent: "shadow", subagentLaunch: "shadow" });
export const SLATE_AUTO_REVIEW_MODES_ENFORCE: SlateAutoReviewModes = Object.freeze({ hostShell: "enforce", boxShell: "enforce", mcp: "enforce", computer: "enforce", automationWrite: "off", cloudAgent: "enforce", subagentLaunch: "enforce" });

export function resolveSlateAutoReviewModes(args: { readonly settingsEnabled: boolean; readonly enforceEnabled: boolean; readonly localOverride?: SlateAutoReviewMode }): SlateAutoReviewModes {
  if (!args.settingsEnabled) return SLATE_AUTO_REVIEW_MODES_OFF;
  if (args.localOverride !== undefined) return { hostShell: args.localOverride, boxShell: args.localOverride, mcp: args.localOverride, computer: args.localOverride, automationWrite: "off", cloudAgent: args.localOverride, subagentLaunch: args.localOverride };
  return args.enforceEnabled ? SLATE_AUTO_REVIEW_MODES_ENFORCE : SLATE_AUTO_REVIEW_MODES_SHADOW;
}

export function formatSlateAutoReviewDeniedReason(classifierReason: string): string {
  return `Auto-review blocked this action: ${classifierReason}. Do not retry the same action, and do not switch to another anonymous public file host, pastebin, disposable transfer link, or similar courier — that is the same unauthorized data-exposure crossing. Ask the user what they want next. Use a safer alternative only when it is a genuinely authorized path.`;
}

export function formatSlateAutoReviewInterruptedForUpdateReason(classifierReason: string): string {
  return `A host update interrupted this approval request before the user could answer \u2014 the user did NOT deny it. After you resume, re-run the action; if it is blocked again, use the tool's approval-retry parameter to raise a fresh approval card. The pending review reason was: ${classifierReason}`;
}

function sanitize(value: string, fallback: string, length: number): string { const trimmed = value.trim(); return (trimmed.length === 0 ? fallback : trimmed).slice(0, length); }
function sanitizeOptional(value: string | undefined, length: number, collapseWhitespace = false): string | undefined { if (value === undefined) return undefined; const trimmed = (collapseWhitespace ? value.replace(/\s+/g, " ") : value).trim(); return trimmed.length === 0 ? undefined : trimmed.slice(0, length); }

interface PendingRecord {
  readonly approval: SlateAutoReviewApproval;
  readonly resolve: (decision: SlateAutoReviewDecision) => void;
  readonly expiryAbort: AbortController;
  readonly signal?: AbortSignal;
  abortListener?: () => void;
}

export class SlateAutoReviewController {
  readonly #pending = new Map<string, PendingRecord>();
  readonly #listeners = new Set<(event: SlateAutoReviewEvent) => void>();
  readonly #approvalTtlMs: number;
  readonly #maxPendingPerAgent: number;
  readonly #approvalsResolvable: boolean;
  readonly #now: () => number;
  #userMessageEpoch = 0;
  #quiescingForHostWindDown = false;

  constructor(readonly options: { readonly agentId: string; readonly hostGeneration: string; readonly approvalTtlMs?: number; readonly maxPendingPerAgent?: number; readonly approvalsResolvable?: boolean; readonly now?: () => number; readonly randomId?: () => string; readonly onDisplayRecheckFailed?: (report: { agentId: string }) => void }) {
    this.#approvalTtlMs = options.approvalTtlMs ?? SLATE_AUTO_REVIEW_APPROVAL_TTL_MS;
    this.#maxPendingPerAgent = options.maxPendingPerAgent ?? SLATE_AUTO_REVIEW_MAX_PENDING_PER_AGENT;
    this.#approvalsResolvable = options.approvalsResolvable ?? true;
    this.#now = options.now ?? Date.now;
  }

  get epoch(): number { return this.#userMessageEpoch; }
  get agentId(): string { return this.options.agentId; }
  get hostGeneration(): string { return this.options.hostGeneration; }

  reportDisplayRecheckFailed(agentId?: string): void { try { this.options.onDisplayRecheckFailed?.({ agentId: agentId ?? this.options.agentId }); } catch {} }

  async requestApproval(request: SlateAutoReviewRequest): Promise<SlateAutoReviewDecision> {
    const agentId = request.agentId ?? this.options.agentId;
    if (request.signal?.aborted === true) return { approved: false, reason: "The action was cancelled." };
    if (this.#quiescingForHostWindDown) return { approved: false, reason: formatSlateAutoReviewInterruptedForUpdateReason(request.reason) };
    if (!this.#approvalsResolvable) return { approved: false, reason: "This action needs Auto-review approval, which isn't available in this conversation. Run it from a direct chat with the assistant." };
    if ([...this.#pending.values()].filter((record) => record.approval.agentId === agentId).length >= this.#maxPendingPerAgent) return { approved: false, reason: "Too many actions are already waiting for Auto-review approval; resolve those first." };
    const createdAtMs = this.#now();
    const command = sanitizeOptional(request.command, 4_000);
    const proposedRule = sanitizeOptional(request.proposedRule, 500, true);
    const expiryPolicy = request.expiryPolicy ?? "ttl";
    const approval: SlateAutoReviewApproval = {
      id: this.options.randomId?.() ?? randomUUID(), agentId, surface: request.surface, fingerprint: request.fingerprint,
      reason: sanitize(request.reason, "This action requires your approval.", 500), summary: sanitize(request.summary, "Sensitive action", 500),
      ...(command === undefined ? {} : { command }), ...(proposedRule === undefined ? {} : { proposedRule }),
      userMessageEpoch: this.#userMessageEpoch, hostGeneration: this.options.hostGeneration, createdAtMs,
      ...(expiryPolicy === "ttl" ? { expiresAtMs: createdAtMs + this.#approvalTtlMs } : {}), status: "pending"
    };
    return new Promise<SlateAutoReviewDecision>((resolve) => {
      const expiryAbort = new AbortController();
      if (expiryPolicy === "ttl") {
        const timer = setTimeout(() => { if (!expiryAbort.signal.aborted) this.#retire(approval.id, "ttl", { approved: false, reason: formatSlateAutoReviewDeniedReason(approval.reason) }); }, this.#approvalTtlMs);
        timer.unref?.();
        expiryAbort.signal.addEventListener("abort", () => clearTimeout(timer), { once: true });
      }
      const record: PendingRecord = { approval, resolve, expiryAbort, ...(request.signal === undefined ? {} : { signal: request.signal }) };
      if (request.signal !== undefined) {
        const abortListener = () => this.#retire(approval.id, "cancelled", { approved: false, reason: "The action was cancelled." });
        record.abortListener = abortListener;
        request.signal.addEventListener("abort", abortListener, { once: true });
      }
      this.#pending.set(approval.id, record);
      this.#emit({ type: "created", approval });
    });
  }

  resolveApproval(approvalId: string, resolution: SlateAutoReviewResolution): SlateAutoReviewApproval | undefined {
    const record = this.#pending.get(approvalId);
    if (record === undefined || record.approval.hostGeneration !== this.options.hostGeneration || record.approval.userMessageEpoch !== this.#userMessageEpoch || (record.approval.expiresAtMs !== undefined && record.approval.expiresAtMs <= this.#now())) return undefined;
    const resolved: SlateAutoReviewApproval = { ...record.approval, status: resolution };
    this.#deletePending(approvalId, record); this.#emit({ type: "resolved", approval: resolved });
    record.resolve(resolution === "denied" ? { approved: false, reason: formatSlateAutoReviewDeniedReason(record.approval.reason) } : { approved: true });
    return resolved;
  }

  getPendingApprovals(): SlateAutoReviewApproval[] { return [...this.#pending.values()].map((record) => record.approval); }
  getPendingApprovalForAgent(agentId: string): SlateAutoReviewApproval | undefined { return [...this.#pending.values()].find((record) => record.approval.agentId === agentId)?.approval; }
  subscribe(listener: (event: SlateAutoReviewEvent) => void): () => void { this.#listeners.add(listener); return () => { this.#listeners.delete(listener); }; }
  beginUserMessageEpoch(): void { this.#userMessageEpoch += 1; this.expire("user_redirect"); }
  expireSurfaces(surfaces: ReadonlySet<SlateAutoReviewSurface>): void { for (const [id, record] of [...this.#pending]) if (surfaces.has(record.approval.surface)) this.#retire(id, "settings_change", { approved: false, reason: "Auto-review settings changed; retry the action." }); }
  expire(cause: SlateAutoReviewExpiryCause): void { for (const [id, record] of [...this.#pending]) this.#retire(id, cause, { approved: false, reason: formatSlateAutoReviewDeniedReason(record.approval.reason) }); }
  expireForQuiesce(): void { this.#quiescingForHostWindDown = true; for (const [id, record] of [...this.#pending]) this.#retire(id, "quiesce", { approved: false, reason: formatSlateAutoReviewInterruptedForUpdateReason(record.approval.reason) }); }
  cancelQuiesce(): void { this.#quiescingForHostWindDown = false; }
  #retire(id: string, cause: SlateAutoReviewExpiryCause, decision: SlateAutoReviewDecision): void { const record = this.#pending.get(id); if (record === undefined) return; const approval: SlateAutoReviewApproval = { ...record.approval, status: "expired" }; this.#deletePending(id, record); this.#emit({ type: "expired", approval, cause }); record.resolve(decision); }
  #deletePending(id: string, record: PendingRecord): void { record.expiryAbort.abort(); if (record.signal !== undefined && record.abortListener !== undefined) record.signal.removeEventListener("abort", record.abortListener); this.#pending.delete(id); }
  #emit(event: SlateAutoReviewEvent): void { for (const listener of this.#listeners) listener(event); }
}

export function fingerprintSlateAutoReviewTarget(target: unknown): string { return createHash("sha256").update(JSON.stringify(target)).digest("hex"); }
