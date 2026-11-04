import { randomUUID } from "node:crypto"

export interface RunnerIdentityOptions {
  readonly conversationId?: string
  readonly getAgentId?: () => string
  readonly boxId?: string
  readonly getBoxId?: () => string
  readonly transcriptId?: string
  readonly getBoxTerminalsFolder?: () => string | undefined
  readonly getBoxWindowIndex?: (boxId: string) => number | undefined
}

export interface RunnerIdentityStampOptions {
  readonly isSubagentRunner: boolean
  readonly subagentType?: string
}

export class RunnerIdentity {
  readonly #fallbackConversationId = `slate-${randomUUID()}`
  #remoteTerminalsFolder: string | undefined

  constructor(private readonly options: RunnerIdentityOptions) {}

  getConversationId(): string {
    return this.options.getAgentId?.() ?? this.options.conversationId ?? this.#fallbackConversationId
  }

  resolveBoxId(): string {
    return this.options.getBoxId?.() ?? this.options.boxId ?? this.getConversationId()
  }

  getTranscriptId(): string {
    return this.options.transcriptId ?? this.getConversationId()
  }

  resolveTerminalsFolder(): string | undefined {
    return this.#remoteTerminalsFolder ?? this.options.getBoxTerminalsFolder?.()
  }

  setRemoteTerminalsFolder(folder: string): void {
    this.#remoteTerminalsFolder = folder
  }

  resolveBrowserEndpoint(cdpPortBase: number): { readonly display: string; readonly cdpUrl: string } | null {
    const displayNumber = this.options.getBoxWindowIndex?.(this.resolveBoxId())
    if (displayNumber === undefined) return null
    return { display: `:${displayNumber}`, cdpUrl: `http://127.0.0.1:${cdpPortBase + displayNumber}` }
  }

  stampInheritableAttributes<C extends Record<string, unknown>>(
    context: C,
    requestId: string,
    turnType: string,
    options: RunnerIdentityStampOptions,
  ): C & { inheritableAttributes: Record<string, string> } {
    const inherited = typeof context.inheritableAttributes === "object" && context.inheritableAttributes != null
      ? context.inheritableAttributes as Record<string, string>
      : {}
    return {
      ...context,
      inheritableAttributes: {
        ...inherited,
        "slate.conversation_id": this.getConversationId(),
        "slate.request_id": requestId,
        "slate.turn_type": turnType,
        ...(options.isSubagentRunner && options.subagentType != null ? { "slate.subagent_type": options.subagentType } : {}),
      },
    }
  }

  stampRootRequestId(span: { setAttribute(key: string, value: string): void }, requestId: string): void {
    try {
      span.setAttribute("slate.request_id", requestId)
    } catch {
      // A span that cannot be annotated has already ended; the turn remains valid.
    }
  }
}
