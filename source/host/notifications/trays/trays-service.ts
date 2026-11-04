import { EventEmitter } from "node:events"

export const MAX_TRAYS = 20

export interface ErrorTray {
  readonly kind: "error"
  readonly id: string
  readonly agentId?: string | undefined
  readonly title: string
  readonly detail: string
  readonly requestId?: string | undefined
  readonly createdAt: number
  readonly errorKind?: string | undefined
  readonly rawDetail?: string | undefined
  readonly actions?: readonly unknown[] | undefined
  readonly dedupeKey?: string
  readonly count?: number
}

export type TrayEvent =
  | { type: "pushed"; tray: ErrorTray }
  | { type: "cleared" }
  | { type: "dismissed"; id: string }

type TrayRequest = Omit<ErrorTray, "kind" | "id" | "createdAt" | "count"> & { count?: number }

export class TrayManager {
  private readonly events = new EventEmitter()
  private snapshot: readonly ErrorTray[] = Object.freeze([])

  constructor(
    private readonly allocateId: () => string = () => crypto.randomUUID(),
    private readonly readClock: () => number = () => Date.now(),
  ) {}

  getTrays(): readonly ErrorTray[] {
    return this.snapshot
  }

  pushError(request: TrayRequest): ErrorTray {
    if (request.dedupeKey !== undefined) {
      const refreshed = this.refresh(request, request.dedupeKey)
      if (refreshed !== undefined) return refreshed
    }

    const tray = this.create(request)
    this.replace([...this.snapshot, tray])
    this.emit({ type: "pushed", tray })
    this.keepNewest()
    return tray
  }

  clearAll(): void {
    if (this.snapshot.length === 0) return
    this.replace([])
    this.emit({ type: "cleared" })
  }

  dismiss(id: string): boolean {
    const next = this.snapshot.filter(tray => tray.id !== id)
    if (next.length === this.snapshot.length) return false
    this.replace(next)
    this.emit({ type: "dismissed", id })
    return true
  }

  clearForAgent(agentId: string): void {
    const removed = this.snapshot.filter(tray => tray.agentId === agentId)
    if (removed.length === 0) return
    this.replace(this.snapshot.filter(tray => tray.agentId !== agentId))
    for (const tray of removed) this.emit({ type: "dismissed", id: tray.id })
  }

  subscribe(listener: (event: TrayEvent) => void): () => void {
    this.events.on("changed", listener)
    return () => this.events.off("changed", listener)
  }

  private refresh(request: TrayRequest, dedupeKey: string): ErrorTray | undefined {
    const at = this.snapshot.findIndex(tray => tray.dedupeKey === dedupeKey)
    const previous = this.snapshot[at]
    if (previous === undefined) return undefined

    const tray: ErrorTray = {
      ...previous,
      title: request.title,
      detail: request.detail,
      requestId: request.requestId,
      count: request.count ?? (previous.count ?? 1) + 1,
      createdAt: this.readClock(),
      errorKind: request.errorKind,
      rawDetail: request.rawDetail,
      actions: actionable(request.actions),
    }
    const next = [...this.snapshot]
    next[at] = tray
    this.replace(next)
    this.emit({ type: "pushed", tray })
    return tray
  }

  private create(request: TrayRequest): ErrorTray {
    const actions = actionable(request.actions)
    return {
      kind: "error",
      id: this.allocateId(),
      agentId: request.agentId,
      title: request.title,
      detail: request.detail,
      requestId: request.requestId,
      createdAt: this.readClock(),
      ...(request.errorKind !== undefined ? { errorKind: request.errorKind } : {}),
      ...(request.rawDetail !== undefined ? { rawDetail: request.rawDetail } : {}),
      ...(actions !== undefined ? { actions } : {}),
      ...(request.dedupeKey !== undefined
        ? { dedupeKey: request.dedupeKey, count: request.count ?? 1 }
        : {}),
    }
  }

  private keepNewest(): void {
    const overflow = Math.max(0, this.snapshot.length - MAX_TRAYS)
    if (overflow === 0) return
    for (const tray of this.snapshot.slice(0, overflow)) {
      this.emit({ type: "dismissed", id: tray.id })
    }
    this.replace(this.snapshot.slice(overflow))
  }

  private replace(trays: readonly ErrorTray[]): void {
    this.snapshot = Object.freeze([...trays])
  }

  private emit(event: TrayEvent): void {
    this.events.emit("changed", event)
  }
}

function actionable(actions: readonly unknown[] | undefined): readonly unknown[] | undefined {
  return actions === undefined || actions.length === 0 ? undefined : actions
}
