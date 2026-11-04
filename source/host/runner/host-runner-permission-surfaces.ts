import { presentOptions } from "./optional-options.ts"

export interface LocalToolPermissionRequest {
  readonly agentId?: unknown
  readonly id?: unknown
  readonly action?: unknown
  readonly target?: unknown
  readonly status?: unknown
  readonly description?: unknown
}

export interface LocalToolPermissionEvent {
  readonly type?: unknown
  readonly request?: LocalToolPermissionRequest
}

export interface LocalToolPermissionTransport {
  onUpdate(update: unknown): void
}

type PermissionEventListener = (event: LocalToolPermissionEvent) => void
type SubscribePermissionEvents = (listener: PermissionEventListener) => (() => void) | undefined

/** One prompt surface per session; a replacement turn retires its predecessor before it subscribes. */
export class HostRunnerPermissionSurfaces {
  private readonly subscriptions = new Map<string, () => void>()

  constructor(
    private readonly subscribe: SubscribePermissionEvents | undefined,
    private readonly now: () => number = Date.now,
  ) {}

  bind(agentId: string, groupMemberTurn: boolean, transport: LocalToolPermissionTransport): void {
    this.forget(agentId)
    if (groupMemberTurn || this.subscribe === undefined) return

    const unsubscribe = this.subscribe((event) => this.forward(agentId, transport, event))
    if (typeof unsubscribe === "function") this.subscriptions.set(agentId, unsubscribe)
  }

  canAsk(agentId: string): boolean {
    return this.subscriptions.has(agentId)
  }

  forget(agentId: string): void {
    const unsubscribe = this.subscriptions.get(agentId)
    if (unsubscribe === undefined) return
    this.subscriptions.delete(agentId)
    unsubscribe()
  }

  dispose(): void {
    for (const unsubscribe of this.subscriptions.values()) unsubscribe()
    this.subscriptions.clear()
  }

  private forward(agentId: string, transport: LocalToolPermissionTransport, event: LocalToolPermissionEvent): void {
    const request = event.request
    if (request?.agentId !== agentId) return

    if (event.type === "created") {
      transport.onUpdate({
        type: "send-message",
        message: {
          type: "local-tool-permission",
          ask: {
            requestId: request.id,
            action: request.action,
            target: request.target,
            status: "pending",
            ...presentOptions({ description: request.description }),
          },
        },
        timestampMs: this.now(),
      })
      return
    }

    transport.onUpdate({
      type: "local-tool-permission-status",
      requestId: request.id,
      status: request.status === "pending" ? "expired" : request.status,
    })
  }
}
