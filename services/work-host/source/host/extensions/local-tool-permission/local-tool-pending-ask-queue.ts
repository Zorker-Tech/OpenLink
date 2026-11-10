import { randomBytes } from "node:crypto";
import {
  SLATE_LOCAL_TOOLS_ASK_EXPIRED_MESSAGE,
  normalizeLocalToolResourcePath,
  type SlateLocalToolRequest,
} from "../../../shared/local-tool-permission-machinery.ts";
import {
  SLATE_LOCAL_TOOL_SETTLED_ID_MEMORY,
  SLATE_LOCAL_TOOLS_ASK_CANCELLED_MESSAGE,
  type LocalToolScope,
  type PendingLocalToolAsk,
  type SlateLocalToolAskRequest,
  type SlateLocalToolControllerEvent,
  type SlateLocalToolDecision,
  type SlateLocalToolRequestStatus,
} from "./local-tool-permission-controller-contracts.ts";

function pendingKey(scope: LocalToolScope, request: SlateLocalToolRequest): string {
  return `${scope.agentId}\0${scope.toolCallId}\0${request.action}\0${request.target}`;
}

function waitUntilSettled(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    if (signal.aborted) return resolve();
    const timeout = setTimeout(resolve, ms);
    timeout.unref?.();
    signal.addEventListener("abort", () => {
      clearTimeout(timeout);
      resolve();
    }, { once: true });
  });
}

export interface LocalToolPendingQueueOptions {
  readonly ttlMs: number;
  readonly now: () => number;
  readonly newId: () => string;
  readonly onSettledRequest: (pending: PendingLocalToolAsk) => void;
  readonly onEvent: (event: SlateLocalToolControllerEvent) => void;
}

export class LocalToolPendingAskQueue {
  private readonly byRequestKey = new Map<string, PendingLocalToolAsk>();
  private readonly requestKeyById = new Map<string, string>();
  private readonly settledRequestIds = new Set<string>();

  constructor(private readonly options: LocalToolPendingQueueOptions) {}

  request(scope: LocalToolScope, request: SlateLocalToolRequest, directionEpoch: number): Promise<SlateLocalToolDecision> {
    const key = pendingKey(scope, request);
    const existing = this.byRequestKey.get(key);
    if (existing !== undefined) return this.join(existing, request.signal);

    const createdAtMs = this.options.now();
    const description = request.description?.trim();
    const resourcePath = normalizeLocalToolResourcePath(request.resourcePath);
    const pending: PendingLocalToolAsk = {
      request: {
        id: this.options.newId(),
        agentId: scope.agentId,
        action: request.action,
        target: request.target,
        status: "pending",
        createdAtMs,
        expiresAtMs: createdAtMs + this.options.ttlMs,
        ...(description == null || description.length === 0 ? {} : { description }),
      },
      waiters: new Set(),
      expiryAbort: new AbortController(),
      toolCallId: scope.toolCallId,
      ...(resourcePath === undefined ? {} : { resourcePath }),
      outlivesScope: request.outlivesScope === true,
      directionEpoch,
    };

    this.byRequestKey.set(key, pending);
    this.requestKeyById.set(pending.request.id, key);
    void waitUntilSettled(this.options.ttlMs, pending.expiryAbort.signal).then(() => {
      if (!pending.expiryAbort.signal.aborted) {
        this.settle(pending, "expired", { allowed: false, reason: SLATE_LOCAL_TOOLS_ASK_EXPIRED_MESSAGE });
      }
    });
    this.options.onEvent({ type: "created", request: pending.request });
    return this.join(pending, request.signal);
  }

  pendingForAgent(agentId: string): SlateLocalToolAskRequest | undefined {
    return [...this.byRequestKey.values()].find((pending) => pending.request.agentId === agentId)?.request;
  }

  pendingById(id: string): SlateLocalToolAskRequest | undefined {
    const key = this.requestKeyById.get(id);
    return key === undefined ? undefined : this.byRequestKey.get(key)?.request;
  }

  recordById(id: string): PendingLocalToolAsk | undefined {
    const key = this.requestKeyById.get(id);
    return key === undefined ? undefined : this.byRequestKey.get(key);
  }

  allPending(): PendingLocalToolAsk[] {
    return [...this.byRequestKey.values()];
  }

  hasPendingId(id: string): boolean {
    return this.requestKeyById.has(id);
  }

  wasSettled(id: string): boolean {
    return this.settledRequestIds.has(id);
  }

  settle(
    pending: PendingLocalToolAsk,
    status: Exclude<SlateLocalToolRequestStatus, "pending">,
    decision: SlateLocalToolDecision,
    options?: { readonly rememberRefusal?: boolean },
  ): SlateLocalToolAskRequest {
    pending.expiryAbort.abort();
    const key = this.requestKeyById.get(pending.request.id);
    if (key !== undefined && this.byRequestKey.get(key) === pending) this.byRequestKey.delete(key);
    this.requestKeyById.delete(pending.request.id);

    const settledRequest: SlateLocalToolAskRequest = { ...pending.request, status };
    pending.request = settledRequest;
    const shouldRemember = options?.rememberRefusal ?? (status !== "allowed" && status !== "always");
    if (shouldRemember) this.options.onSettledRequest(pending);

    this.settledRequestIds.add(settledRequest.id);
    if (this.settledRequestIds.size > SLATE_LOCAL_TOOL_SETTLED_ID_MEMORY) {
      const oldest = this.settledRequestIds.values().next();
      if (!oldest.done) this.settledRequestIds.delete(oldest.value);
    }

    for (const waiter of [...pending.waiters]) waiter(decision);
    pending.waiters.clear();
    this.options.onEvent({ type: "settled", request: settledRequest });
    return settledRequest;
  }

  private join(pending: PendingLocalToolAsk, signal?: AbortSignal): Promise<SlateLocalToolDecision> {
    return new Promise((resolve) => {
      const settleWaiter = (decision: SlateLocalToolDecision) => {
        pending.waiters.delete(settleWaiter);
        signal?.removeEventListener("abort", abortWaiter);
        resolve(decision);
        if (pending.waiters.size === 0 && this.requestKeyById.has(pending.request.id)) {
          this.settle(pending, "expired", { allowed: false, reason: SLATE_LOCAL_TOOLS_ASK_CANCELLED_MESSAGE });
        }
      };
      const abortWaiter = () => settleWaiter({ allowed: false, reason: SLATE_LOCAL_TOOLS_ASK_CANCELLED_MESSAGE });

      pending.waiters.add(settleWaiter);
      if (signal === undefined) return;
      if (signal.aborted) abortWaiter();
      else signal.addEventListener("abort", abortWaiter, { once: true });
    });
  }
}
