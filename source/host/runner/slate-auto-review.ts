import { createHash, randomUUID } from "node:crypto"

export const SLATE_AUTO_REVIEW_APPROVAL_TTL_MS = 10 * 60 * 1_000
export const SLATE_AUTO_REVIEW_MAX_PENDING_PER_AGENT = 4
export const SLATE_AUTO_REVIEW_HOST_GENERATION = randomUUID()

export type SlateAutoReviewMode = "off" | "shadow" | "enforce"
export type SlateAutoReviewSurface =
  | "hostShell"
  | "boxShell"
  | "mcp"
  | "computer"
  | "automationWrite"
  | "cloudAgent"
  | "subagentLaunch"
  | string
export type SlateAutoReviewResolution = "approved" | "denied"
export type SlateAutoReviewExpiryCause =
  | "ttl"
  | "cancelled"
  | "user_redirect"
  | "settings_change"
  | "session_end"
  | "quiesce"
  | string
export type SlateAutoReviewExpiryPolicy = "park" | "ttl"

export interface SlateAutoReviewModes {
  readonly hostShell: SlateAutoReviewMode
  readonly boxShell: SlateAutoReviewMode
  readonly mcp: SlateAutoReviewMode
  readonly computer: SlateAutoReviewMode
  readonly automationWrite: "off"
  readonly cloudAgent: SlateAutoReviewMode
  readonly subagentLaunch: SlateAutoReviewMode
}

export interface SlateAutoReviewApproval {
  readonly id: string
  readonly agentId: string
  readonly surface: SlateAutoReviewSurface
  readonly fingerprint: string
  readonly reason: string
  readonly summary: string
  readonly command?: string
  readonly proposedRule?: string
  readonly userMessageEpoch: number
  readonly hostGeneration: string
  readonly createdAtMs: number
  readonly expiresAtMs?: number
  readonly status: "pending" | SlateAutoReviewResolution | "expired"
}

export type SlateAutoReviewEvent =
  | { readonly type: "created" | "resolved"; readonly approval: SlateAutoReviewApproval }
  | {
      readonly type: "expired"
      readonly approval: SlateAutoReviewApproval
      readonly cause: SlateAutoReviewExpiryCause
    }

export interface SlateAutoReviewRequest {
  readonly agentId?: string
  readonly surface: SlateAutoReviewSurface
  readonly fingerprint: string
  readonly reason: string
  readonly summary: string
  readonly command?: string
  readonly proposedRule?: string
  readonly expiryPolicy?: SlateAutoReviewExpiryPolicy
  readonly signal?: AbortSignal
}

export type SlateAutoReviewDecision =
  | { readonly approved: true }
  | { readonly approved: false; readonly reason: string }

export function slateAutoReviewApprovalExpiryPolicy(source: string): SlateAutoReviewExpiryPolicy {
  return source === "turn" || source === "handoff-resume" ? "park" : "ttl"
}

function modesFor(mode: SlateAutoReviewMode): SlateAutoReviewModes {
  return Object.freeze({
    hostShell: mode,
    boxShell: mode,
    mcp: mode,
    computer: mode,
    automationWrite: "off" as const,
    cloudAgent: mode,
    subagentLaunch: mode,
  })
}

export const SLATE_AUTO_REVIEW_MODES_OFF = modesFor("off")
export const SLATE_AUTO_REVIEW_MODES_SHADOW = modesFor("shadow")
export const SLATE_AUTO_REVIEW_MODES_ENFORCE = modesFor("enforce")

export function resolveSlateAutoReviewModes(args: {
  readonly settingsEnabled: boolean
  readonly enforceEnabled: boolean
  readonly localOverride?: SlateAutoReviewMode
}): SlateAutoReviewModes {
  if (!args.settingsEnabled) return SLATE_AUTO_REVIEW_MODES_OFF
  if (args.localOverride !== undefined) return modesFor(args.localOverride)
  return args.enforceEnabled
    ? SLATE_AUTO_REVIEW_MODES_ENFORCE
    : SLATE_AUTO_REVIEW_MODES_SHADOW
}

export function formatSlateAutoReviewDeniedReason(classifierReason: string): string {
  return `Auto-review blocked this action: ${classifierReason}. Do not retry the same action, and do not switch to another anonymous public file host, pastebin, disposable transfer link, or similar courier — that is the same unauthorized data-exposure crossing. Ask the user what they want next. Use a safer alternative only when it is a genuinely authorized path.`
}

export function formatSlateAutoReviewInterruptedForUpdateReason(classifierReason: string): string {
  return `A host update interrupted this approval request before the user could answer \u2014 the user did NOT deny it. After you resume, re-run the action; if it is blocked again, use the tool's approval-retry parameter to raise a fresh approval card. The pending review reason was: ${classifierReason}`
}

function boundedText(value: string, fallback: string, limit: number): string {
  const candidate = value.trim() || fallback
  return candidate.slice(0, limit)
}

function boundedOptionalText(
  value: string | undefined,
  limit: number,
  collapseWhitespace = false,
): string | undefined {
  if (value === undefined) return undefined
  const candidate = (collapseWhitespace ? value.replace(/\s+/g, " ") : value).trim()
  return candidate.length === 0 ? undefined : candidate.slice(0, limit)
}

interface PendingApproval {
  readonly approval: SlateAutoReviewApproval
  readonly settle: (decision: SlateAutoReviewDecision) => void
  readonly expiryAbort: AbortController
  readonly signal?: AbortSignal
  abortListener?: () => void
}

export class SlateAutoReviewController {
  readonly #pending = new Map<string, PendingApproval>()
  readonly #listeners = new Set<(event: SlateAutoReviewEvent) => void>()
  readonly #approvalTtlMs: number
  readonly #maxPendingPerAgent: number
  readonly #approvalsResolvable: boolean
  readonly #clock: () => number
  #epoch = 0
  #windingDown = false

  constructor(
    readonly options: {
      readonly agentId: string
      readonly hostGeneration: string
      readonly approvalTtlMs?: number
      readonly maxPendingPerAgent?: number
      readonly approvalsResolvable?: boolean
      readonly now?: () => number
      readonly randomId?: () => string
      readonly onDisplayRecheckFailed?: (report: { agentId: string }) => void
    },
  ) {
    this.#approvalTtlMs = options.approvalTtlMs ?? SLATE_AUTO_REVIEW_APPROVAL_TTL_MS
    this.#maxPendingPerAgent = options.maxPendingPerAgent ?? SLATE_AUTO_REVIEW_MAX_PENDING_PER_AGENT
    this.#approvalsResolvable = options.approvalsResolvable ?? true
    this.#clock = options.now ?? Date.now
  }

  get epoch(): number {
    return this.#epoch
  }

  get agentId(): string {
    return this.options.agentId
  }

  get hostGeneration(): string {
    return this.options.hostGeneration
  }

  reportDisplayRecheckFailed(agentId?: string): void {
    try {
      this.options.onDisplayRecheckFailed?.({ agentId: agentId ?? this.options.agentId })
    } catch {
      // Display diagnostics cannot turn a recovery failure into a second failure.
    }
  }

  async requestApproval(request: SlateAutoReviewRequest): Promise<SlateAutoReviewDecision> {
    const agentId = request.agentId ?? this.options.agentId
    if (request.signal?.aborted === true) {
      return { approved: false, reason: "The action was cancelled." }
    }
    if (this.#windingDown) {
      return {
        approved: false,
        reason: formatSlateAutoReviewInterruptedForUpdateReason(request.reason),
      }
    }
    if (!this.#approvalsResolvable) {
      return {
        approved: false,
        reason: "This action needs Auto-review approval, which isn't available in this conversation. Run it from a direct chat with the assistant.",
      }
    }
    if (this.#countForAgent(agentId) >= this.#maxPendingPerAgent) {
      return {
        approved: false,
        reason: "Too many actions are already waiting for Auto-review approval; resolve those first.",
      }
    }

    const approval = this.#createApproval(request, agentId)
    const decision = new Promise<SlateAutoReviewDecision>((settle) => {
      const expiryAbort = new AbortController()
      if (approval.expiresAtMs !== undefined) this.#scheduleExpiry(approval, expiryAbort)
      const record: PendingApproval = {
        approval,
        settle,
        expiryAbort,
        ...(request.signal === undefined ? {} : { signal: request.signal }),
      }
      if (request.signal !== undefined) {
        record.abortListener = () => {
          this.#end(approval.id, "cancelled", {
            approved: false,
            reason: "The action was cancelled.",
          })
        }
        request.signal.addEventListener("abort", record.abortListener, { once: true })
      }
      this.#pending.set(approval.id, record)
    })
    this.#publish({ type: "created", approval })
    return decision
  }

  #countForAgent(agentId: string): number {
    let count = 0
    for (const pending of this.#pending.values()) {
      if (pending.approval.agentId === agentId) count += 1
    }
    return count
  }

  #createApproval(request: SlateAutoReviewRequest, agentId: string): SlateAutoReviewApproval {
    const createdAtMs = this.#clock()
    const command = boundedOptionalText(request.command, 4_000)
    const proposedRule = boundedOptionalText(request.proposedRule, 500, true)
    return {
      id: this.options.randomId?.() ?? randomUUID(),
      agentId,
      surface: request.surface,
      fingerprint: request.fingerprint,
      reason: boundedText(
        request.reason,
        "This action requires your approval.",
        500,
      ),
      summary: boundedText(request.summary, "Sensitive action", 500),
      ...(command === undefined ? {} : { command }),
      ...(proposedRule === undefined ? {} : { proposedRule }),
      userMessageEpoch: this.#epoch,
      hostGeneration: this.options.hostGeneration,
      createdAtMs,
      ...((request.expiryPolicy ?? "ttl") === "ttl"
        ? { expiresAtMs: createdAtMs + this.#approvalTtlMs }
        : {}),
      status: "pending",
    }
  }

  #scheduleExpiry(approval: SlateAutoReviewApproval, expiryAbort: AbortController): void {
    const timer = setTimeout(() => {
      if (expiryAbort.signal.aborted) return
      this.#end(approval.id, "ttl", {
        approved: false,
        reason: formatSlateAutoReviewDeniedReason(approval.reason),
      })
    }, this.#approvalTtlMs)
    timer.unref?.()
    expiryAbort.signal.addEventListener("abort", () => clearTimeout(timer), { once: true })
  }

  resolveApproval(
    approvalId: string,
    resolution: SlateAutoReviewResolution,
  ): SlateAutoReviewApproval | undefined {
    const pending = this.#pending.get(approvalId)
    if (pending === undefined) return undefined
    if (pending.approval.hostGeneration !== this.options.hostGeneration) return undefined
    if (pending.approval.userMessageEpoch !== this.#epoch) return undefined
    if (pending.approval.expiresAtMs !== undefined && pending.approval.expiresAtMs <= this.#clock()) {
      return undefined
    }

    const resolved = { ...pending.approval, status: resolution } as const
    this.#removePending(approvalId, pending)
    pending.settle(
      resolution === "approved"
        ? { approved: true }
        : {
            approved: false,
            reason: formatSlateAutoReviewDeniedReason(pending.approval.reason),
          },
    )
    this.#publish({ type: "resolved", approval: resolved })
    return resolved
  }

  getPendingApprovals(): SlateAutoReviewApproval[] {
    return [...this.#pending.values()].map(pending => pending.approval)
  }

  getPendingApprovalForAgent(agentId: string): SlateAutoReviewApproval | undefined {
    for (const pending of this.#pending.values()) {
      if (pending.approval.agentId === agentId) return pending.approval
    }
    return undefined
  }

  subscribe(listener: (event: SlateAutoReviewEvent) => void): () => void {
    this.#listeners.add(listener)
    return () => this.#listeners.delete(listener)
  }

  beginUserMessageEpoch(): void {
    this.#epoch += 1
    this.expire("user_redirect")
  }

  expireSurfaces(surfaces: ReadonlySet<SlateAutoReviewSurface>): void {
    for (const [id, pending] of [...this.#pending]) {
      if (surfaces.has(pending.approval.surface)) {
        this.#end(id, "settings_change", {
          approved: false,
          reason: "Auto-review settings changed; retry the action.",
        })
      }
    }
  }

  expire(cause: SlateAutoReviewExpiryCause): void {
    for (const [id, pending] of [...this.#pending]) {
      this.#end(id, cause, {
        approved: false,
        reason: formatSlateAutoReviewDeniedReason(pending.approval.reason),
      })
    }
  }

  expireForQuiesce(): void {
    this.#windingDown = true
    for (const [id, pending] of [...this.#pending]) {
      this.#end(id, "quiesce", {
        approved: false,
        reason: formatSlateAutoReviewInterruptedForUpdateReason(pending.approval.reason),
      })
    }
  }

  cancelQuiesce(): void {
    this.#windingDown = false
  }

  #end(
    approvalId: string,
    cause: SlateAutoReviewExpiryCause,
    decision: SlateAutoReviewDecision,
  ): void {
    const pending = this.#pending.get(approvalId)
    if (pending === undefined) return
    const expired = { ...pending.approval, status: "expired" } as const
    this.#removePending(approvalId, pending)
    pending.settle(decision)
    this.#publish({ type: "expired", approval: expired, cause })
  }

  #removePending(approvalId: string, pending: PendingApproval): void {
    pending.expiryAbort.abort()
    if (pending.signal !== undefined && pending.abortListener !== undefined) {
      pending.signal.removeEventListener("abort", pending.abortListener)
    }
    this.#pending.delete(approvalId)
  }

  #publish(event: SlateAutoReviewEvent): void {
    for (const listener of this.#listeners) {
      try {
        listener(event)
      } catch {
        // Observers report the decision; they do not own it.
      }
    }
  }
}

export function fingerprintSlateAutoReviewTarget(target: unknown): string {
  return createHash("sha256").update(JSON.stringify(target)).digest("hex")
}
