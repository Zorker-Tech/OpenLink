/**
 * The trays the platform shows a user.
 *
 * Each tray is an error, a question or a note, bounded in number and de-duplicated by what it is about, and a reader is
 * handed the list as it stood when it asked: publishing a change replaces the list rather than editing it, so a reader
 * that kept the old one is not surprised by a later tray.
 */
import { EventEmitter } from "node:events";

export const MAX_TRAYS = 20;

export interface ErrorTray {
  readonly kind: "error";
  readonly id: string;
  readonly agentId?: string | undefined;
  readonly title: string;
  readonly detail: string;
  readonly requestId?: string | undefined;
  readonly createdAt: number;
  readonly errorKind?: string | undefined;
  readonly rawDetail?: string | undefined;
  readonly actions?: readonly unknown[] | undefined;
  readonly dedupeKey?: string;
  readonly count?: number;
}

export type TrayEvent = { type: "pushed"; tray: ErrorTray } | { type: "cleared" } | { type: "dismissed"; id: string };

/** What a caller brings when it raises a tray: everything but the three fields the manager decides. */
type TrayRequest = Omit<ErrorTray, "kind" | "id" | "createdAt" | "count"> & { count?: number };

/** A list of actions, when there are any to offer. */
function offered(actions: readonly unknown[] | undefined): readonly unknown[] | undefined {
  return actions != null && actions.length > 0 ? actions : undefined;
}

export class TrayManager {
  private readonly emitter = new EventEmitter();
  private trays: ErrorTray[] = [];

  constructor(
    private readonly createId: () => string = () => crypto.randomUUID(),
    private readonly now: () => number = () => Date.now(),
  ) {}

  getTrays(): readonly ErrorTray[] {
    return this.trays;
  }

  /**
   * Raises a tray, or — when a tray is already about the same thing — brings that one up to date and counts it.
   *
   * An update keeps the tray's identity and place and takes the new wording; the count is the caller's if it brought
   * one, and otherwise one more than the tray had.
   */
  pushError(options: TrayRequest): ErrorTray {
    if (options.dedupeKey != null) {
      const updated = this.refresh(options, options.dedupeKey);
      if (updated !== null) return updated;
    }
    const tray = this.build(options);
    this.trays = [...this.trays, tray];
    this.publish({ type: "pushed", tray });
    this.enforceCap();
    return tray;
  }

  /** Brings the tray about this thing up to date, or answers nothing when there is not one. */
  private refresh(options: TrayRequest, dedupeKey: string): ErrorTray | null {
    const index = this.trays.findIndex((tray) => tray.dedupeKey === dedupeKey);
    const existing = index === -1 ? undefined : this.trays[index];
    if (existing === undefined) return null;
    const updated: ErrorTray = {
      ...existing,
      title: options.title,
      detail: options.detail,
      requestId: options.requestId,
      count: options.count ?? (existing.count ?? 1) + 1,
      createdAt: this.now(),
      errorKind: options.errorKind,
      rawDetail: options.rawDetail,
      actions: offered(options.actions),
    };
    const next = [...this.trays];
    next[index] = updated;
    this.trays = next;
    this.publish({ type: "pushed", tray: updated });
    return updated;
  }

  /** A new tray, with only the fields the caller actually brought. */
  private build(options: TrayRequest): ErrorTray {
    const actions = offered(options.actions);
    return {
      kind: "error",
      id: this.createId(),
      agentId: options.agentId,
      title: options.title,
      detail: options.detail,
      requestId: options.requestId,
      createdAt: this.now(),
      ...(options.errorKind != null ? { errorKind: options.errorKind } : {}),
      ...(options.rawDetail != null ? { rawDetail: options.rawDetail } : {}),
      ...(actions !== undefined ? { actions } : {}),
      ...(options.dedupeKey != null ? { dedupeKey: options.dedupeKey, count: options.count ?? 1 } : {}),
    };
  }

  clearAll(): void {
    if (this.trays.length === 0) return;
    this.trays = [];
    this.publish({ type: "cleared" });
  }

  dismiss(id: string): boolean {
    const remaining = this.trays.filter((tray) => tray.id !== id);
    if (remaining.length === this.trays.length) return false;
    this.trays = remaining;
    this.publish({ type: "dismissed", id });
    return true;
  }

  /** Dismisses every tray an agent raised, one event each, in the order they were raised. */
  clearForAgent(agentId: string): void {
    const removed = this.trays.filter((tray) => tray.agentId === agentId);
    if (removed.length === 0) return;
    this.trays = this.trays.filter((tray) => tray.agentId !== agentId);
    for (const tray of removed) this.publish({ type: "dismissed", id: tray.id });
  }

  subscribe(listener: (event: TrayEvent) => void): () => void {
    this.emitter.on("event", listener);
    return () => this.emitter.off("event", listener);
  }

  /** Keeps the newest ones: a tray that overflows the cap is dismissed oldest first, one event each. */
  private enforceCap(): void {
    if (this.trays.length <= MAX_TRAYS) return;
    const overflow = this.trays.length - MAX_TRAYS;
    for (const tray of this.trays.slice(0, overflow)) this.publish({ type: "dismissed", id: tray.id });
    this.trays = this.trays.slice(overflow);
  }

  private publish(event: TrayEvent): void {
    this.emitter.emit("event", event);
  }
}
