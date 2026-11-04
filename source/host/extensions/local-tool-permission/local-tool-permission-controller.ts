/**
 * Applies local-execution permission settings, reuses active approvals and resolves user asks for one agent turn.
 */

import { randomBytes } from "node:crypto";
import {
  SLATE_NO_LOCAL_MACHINE_MESSAGE,
} from "../../../shared/local-exec-gateway.ts";
import type { SlateLocalToolPermission } from "../../../shared/local-tool-permission.ts";
import {
  SLATE_LOCAL_TOOL_ASK_TTL_MS,
  SLATE_LOCAL_TOOLS_ASK_EXPIRED_MESSAGE,
  SLATE_LOCAL_TOOLS_ABANDONED_MESSAGE,
  SLATE_LOCAL_TOOLS_ASK_UNAVAILABLE_MESSAGE,
  SLATE_LOCAL_TOOLS_DENIED_MESSAGE,
  SLATE_LOCAL_TOOLS_DISABLED_MESSAGE,
  SLATE_LOCAL_TOOLS_PREPARATORY_MESSAGE,
  SLATE_LOCAL_TOOLS_TARGET_TOO_LARGE_MESSAGE,
  SLATE_LOCAL_TOOLS_UNAPPROVED_MESSAGE,
  localToolApprovalCovers,
  normalizeLocalToolResourcePath,
  type SlateLocalToolApproval,
  type SlateLocalToolRequest,
  type SlateLocalToolScope,
} from "../../../shared/local-tool-permission-machinery.ts";
import {
  SLATE_LOCAL_TOOL_TARGET_MAX_CHARS,
  SLATE_LOCAL_TOOLS_ASK_CANCELLED_MESSAGE,
  type LocalToolScope,
  type PendingLocalToolAsk,
  type SlateLocalToolPermissionControllerOptions,
  type SlateLocalToolRequestStatus,
  type SlateLocalToolResolution,
  type SlateLocalToolDecision,
  type SlateLocalToolAskRequest,
  type SlateLocalToolControllerEvent,
} from "./local-tool-permission-controller-contracts.ts";
import { LocalToolPendingAskQueue } from "./local-tool-pending-ask-queue.ts";
import { LocalToolRefusalMemory } from "./local-tool-permission-refusal-memory.ts";

export {
  SLATE_LOCAL_TOOL_FORGOTTEN_AGENT_MEMORY,
  SLATE_LOCAL_TOOL_REFUSAL_DIRECTION_WINDOW,
  SLATE_LOCAL_TOOL_REFUSED_ACTION_MEMORY_PER_AGENT,
  SLATE_LOCAL_TOOL_SETTLED_ID_MEMORY,
  SLATE_LOCAL_TOOL_TARGET_MAX_CHARS,
  SLATE_LOCAL_TOOLS_ASK_CANCELLED_MESSAGE,
} from "./local-tool-permission-controller-contracts.ts";
export type {
  SlateLocalToolAskRequest,
  SlateLocalToolControllerEvent,
  SlateLocalToolDecision,
  SlateLocalToolPermissionControllerOptions,
  SlateLocalToolRequestStatus,
  SlateLocalToolResolution,
} from "./local-tool-permission-controller-contracts.ts";

type SettledRequestStatus = Exclude<SlateLocalToolRequestStatus, "pending" | "expired">;
type ResolutionStatusMap = Readonly<Record<SlateLocalToolResolution, SettledRequestStatus>>;

interface StoredApproval extends SlateLocalToolApproval {
  readonly id: string;
  readonly agentId: string;
  readonly toolCallId: string;
  readonly outlivesScope: boolean;
}

const STATUS_FOR_RESOLUTION: ResolutionStatusMap = {
  "allow-once": "allowed",
  deny: "denied",
  always: "always",
  never: "never",
};

export class SlateLocalToolPermissionController {
  private readonly pendingAsks: LocalToolPendingAskQueue;
  private readonly approvalsById = new Map<string, StoredApproval>();
  private readonly refusalMemory = new LocalToolRefusalMemory();
  private readonly listeners = new Set<(event: SlateLocalToolControllerEvent) => void>();
  private readonly askTtlMs: number;
  private readonly now: () => number;

  constructor(private readonly options: SlateLocalToolPermissionControllerOptions) {
    this.askTtlMs = options.askTtlMs ?? SLATE_LOCAL_TOOL_ASK_TTL_MS;
    this.now = options.now ?? Date.now;
    this.pendingAsks = new LocalToolPendingAskQueue({
      ttlMs: this.askTtlMs,
      now: this.now,
      newId: options.randomId ?? (() => randomBytes(32).toString("hex")),
      onSettledRequest: (pending) => this.rememberRefusal(pending),
      onEvent: (event) => this.emit(event),
    });
  }

  permission(): SlateLocalToolPermission {
    return this.options.getPermission();
  }

  blockedReason(): string | undefined {
    return this.permission() === "never" ? SLATE_LOCAL_TOOLS_DISABLED_MESSAGE : undefined;
  }

  requiresApproval(): boolean {
    return this.permission() === "ask";
  }

  async awaitDesktopStandingDecision(args: {
    readonly agentId: string;
    readonly toolCallId: string;
    readonly command?: string;
    readonly description?: string;
    readonly signal?: AbortSignal;
  }): Promise<SlateLocalToolDecision> {
    const permission = this.permission();
    if (permission === "never") return { allowed: false, reason: SLATE_LOCAL_TOOLS_DISABLED_MESSAGE };
    if (permission === "always") return { allowed: true };

    return this.authorize(
      {
        agentId: args.agentId,
        toolCallId: args.toolCallId,
        action: "run-command",
        directionEpoch: this.directionEpoch(args.agentId),
      },
      {
        action: "run-command",
        target: args.command ?? "",
        ...(args.description == null || args.description.length === 0 ? {} : { description: args.description }),
        ...(args.signal === undefined ? {} : { signal: args.signal }),
      },
    );
  }

  async authorize(
    scope: SlateLocalToolScope | undefined,
    request: SlateLocalToolRequest,
  ): Promise<SlateLocalToolDecision> {
    const permission = this.permission();
    if (permission === "never") return { allowed: false, reason: SLATE_LOCAL_TOOLS_DISABLED_MESSAGE };

    if (scope !== undefined) {
      const refusal = this.refusalMemory.refusalFor(scope, request);
      if (refusal !== undefined) return { allowed: false, reason: refusal };
    }

    if (permission === "always" && !this.refusalMemory.predatesStandingGrant(scope)) return { allowed: true };
    if (scope === undefined) return { allowed: false, reason: SLATE_LOCAL_TOOLS_UNAPPROVED_MESSAGE };

    if (scope.toolCallId === undefined) {
      const approval = this.findApprovalForResource(scope.agentId, request.attachToResourcePath);
      return approval === undefined
        ? { allowed: false, reason: SLATE_LOCAL_TOOLS_UNAPPROVED_MESSAGE }
        : { allowed: true, approvalId: approval.id };
    }

    return this.ask(scope as LocalToolScope, request);
  }

  completeScope(scope?: SlateLocalToolScope): void {
    if (scope?.toolCallId === undefined) return;
    for (const approval of [...this.approvalsById.values()]) {
      if (approval.agentId === scope.agentId && approval.toolCallId === scope.toolCallId && !approval.outlivesScope) {
        this.retireApproval(approval.id);
      }
    }
  }

  beginTurn(agentId: string): void {
    this.refusalMemory.advanceDirection(agentId);
    for (const approval of [...this.approvalsById.values()]) {
      if (approval.agentId === agentId) this.retireApproval(approval.id);
    }
    for (const pending of this.pendingAsks.allPending()) {
      if (pending.request.agentId === agentId) {
        this.settle(pending, "expired", { allowed: false, reason: SLATE_LOCAL_TOOLS_ASK_EXPIRED_MESSAGE });
      }
    }
  }

  directionEpoch(agentId: string): number {
    return this.refusalMemory.directionEpoch(agentId);
  }

  forgetAgent(agentId: string): void {
    this.beginTurn(agentId);
    this.refusalMemory.forgetAgent(agentId);
  }

  rememberedRefusalCount(): number {
    return this.refusalMemory.refusalCount();
  }

  retainedAgentIds(): string[] {
    return [
      ...new Set([
        ...this.refusalMemory.retainedAgentIds(),
        ...[...this.approvalsById.values()].map((approval) => approval.agentId),
        ...this.pendingAsks.allPending().map((pending) => pending.request.agentId),
      ]),
    ];
  }

  notePermissionChanged(): void {
    const permission = this.permission();
    this.refusalMemory.notePermission(permission);
    if (permission === "ask") return;

    const nowAllowed = permission === "always";
    if (!nowAllowed) {
      for (const approvalId of [...this.approvalsById.keys()]) this.retireApproval(approvalId);
    }

    for (const pending of this.pendingAsks.allPending()) {
      if (nowAllowed && this.refusalMemory.isStalePending(pending.request.agentId, pending.directionEpoch)) {
        this.settle(pending, "expired", { allowed: false, reason: SLATE_LOCAL_TOOLS_ABANDONED_MESSAGE }, { rememberRefusal: false });
        continue;
      }

      const decision = nowAllowed
        ? { allowed: true }
        : { allowed: false, reason: SLATE_LOCAL_TOOLS_DISABLED_MESSAGE };
      this.settle(pending, nowAllowed ? "always" : "never", decision, {
        rememberRefusal: false,
      });
    }
  }

  resolveRequest(requestId: string, initialResolution: SlateLocalToolResolution): SlateLocalToolAskRequest | undefined {
    const pending = this.pendingAsks.recordById(requestId);
    if (pending === undefined || pending.request.id !== requestId) return undefined;

    let resolution = initialResolution;
    if (resolution === "always" || resolution === "never") {
      try {
        this.options.setPermission(resolution);
      } catch {
        // The individual answer still applies when a settings write cannot be saved.
      }
      if (resolution === "always" && this.permission() !== "always") resolution = "allow-once";
    }

    const allowed = resolution === "allow-once" || resolution === "always";
    if (allowed) {
      this.approvalsById.set(requestId, {
        id: requestId,
        agentId: pending.request.agentId,
        toolCallId: pending.toolCallId,
        outlivesScope: pending.outlivesScope,
        action: pending.request.action,
        target: pending.request.target,
        ...(pending.resourcePath === undefined ? {} : { resourcePath: pending.resourcePath }),
      });
    }

    const deniedReason = resolution === "never"
      ? SLATE_LOCAL_TOOLS_DISABLED_MESSAGE
      : SLATE_LOCAL_TOOLS_DENIED_MESSAGE;
    const settled = this.settle(
      pending,
      STATUS_FOR_RESOLUTION[resolution],
      allowed ? { allowed: true, approvalId: requestId } : { allowed: false, reason: deniedReason },
    );
    if (resolution === "always" || resolution === "never") this.notePermissionChanged();
    return settled;
  }

  getPendingRequestForAgent(agentId: string): SlateLocalToolAskRequest | undefined {
    return this.pendingAsks.pendingForAgent(agentId);
  }

  getPendingRequestById(id: string): SlateLocalToolAskRequest | undefined {
    return this.pendingAsks.pendingById(id);
  }

  wasSettled(id: string): boolean {
    return this.pendingAsks.wasSettled(id);
  }

  liveApprovalIds(): string[] {
    return [...this.approvalsById.keys()];
  }

  subscribe(listener: (event: SlateLocalToolControllerEvent) => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  findApprovalForResource(agentId: string, resourcePath?: string): StoredApproval | undefined {
    const normalizedResource = normalizeLocalToolResourcePath(resourcePath);
    if (normalizedResource === undefined) return undefined;
    return [...this.approvalsById.values()].find(
      (approval) => approval.agentId === agentId
        && normalizeLocalToolResourcePath(approval.resourcePath) === normalizedResource,
    );
  }

  retireApproval(id: string): void {
    if (!this.approvalsById.delete(id)) return;
    this.options.onApprovalRetired?.(id);
  }

  refusalFor(scope: SlateLocalToolScope, request: SlateLocalToolRequest): string | undefined {
    return this.refusalMemory.refusalFor(scope, request);
  }

  private scopeEpoch(scope: SlateLocalToolScope): number {
    return scope.directionEpoch ?? this.directionEpoch(scope.agentId);
  }

  private rememberRefusal(pending: PendingLocalToolAsk): void {
    this.refusalMemory.rememberRefusal({
      agentId: pending.request.agentId,
      action: pending.request.action,
      target: pending.request.target,
      directionEpoch: pending.directionEpoch,
    });
  }

  private async ask(scope: LocalToolScope, request: SlateLocalToolRequest): Promise<SlateLocalToolDecision> {
    const covered = [...this.approvalsById.values()].find((approval) =>
      approval.agentId === scope.agentId
      && (approval.toolCallId === scope.toolCallId || approval.resourcePath !== undefined)
      && localToolApprovalCovers(approval, request));
    if (covered !== undefined) {
      if (request.outlivesScope === true && !covered.outlivesScope) {
        this.approvalsById.set(covered.id, { ...covered, outlivesScope: true });
      }
      return { allowed: true, approvalId: covered.id };
    }

    if (this.options.canAsk?.(scope.agentId) === false) {
      return { allowed: false, reason: SLATE_LOCAL_TOOLS_ASK_UNAVAILABLE_MESSAGE };
    }
    if (this.options.hasLiveComputer?.(scope.agentId) === false) {
      return { allowed: false, reason: SLATE_NO_LOCAL_MACHINE_MESSAGE };
    }

    const scopeAlreadyApproved = scope.action !== undefined
      && [...this.approvalsById.values()].some((approval) =>
        approval.agentId === scope.agentId
        && approval.toolCallId === scope.toolCallId
        && approval.action === scope.action);
    if (scope.action !== undefined && scope.action !== request.action && !scopeAlreadyApproved) {
      return { allowed: false, reason: SLATE_LOCAL_TOOLS_PREPARATORY_MESSAGE };
    }
    if (request.signal?.aborted === true) {
      return { allowed: false, reason: SLATE_LOCAL_TOOLS_ASK_CANCELLED_MESSAGE };
    }
    if (request.target.length > SLATE_LOCAL_TOOL_TARGET_MAX_CHARS) {
      return {
        allowed: false,
        reason: SLATE_LOCAL_TOOLS_TARGET_TOO_LARGE_MESSAGE,
      };
    }

    return this.pendingAsks.request(scope, request, this.scopeEpoch(scope));
  }

  private settle(
    pending: PendingLocalToolAsk,
    status: Exclude<SlateLocalToolRequestStatus, "pending">,
    decision: SlateLocalToolDecision,
    options?: { readonly rememberRefusal?: boolean },
  ): SlateLocalToolAskRequest {
    return this.pendingAsks.settle(pending, status, decision, options);
  }

  private emit(event: SlateLocalToolControllerEvent): void {
    for (const listener of this.listeners) listener(event);
  }
}
