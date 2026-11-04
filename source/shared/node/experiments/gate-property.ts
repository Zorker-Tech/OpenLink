/** A boolean switch with isolated change listeners. */

import { errorLogTag } from "../../errors/summary.ts";
import { reportExperimentsDiagnostic } from "./experiments-diagnostics.ts";

type GateListener = (enabled: boolean) => void;

export class MutableGateProperty {
  private readonly subscribers = new Set<GateListener>();

  constructor(private enabled: boolean) {}

  get(): boolean {
    return this.enabled;
  }

  subscribe(listener: GateListener): () => void {
    this.subscribers.add(listener);
    return () => this.subscribers.delete(listener);
  }

  set(next: boolean): void {
    if (next === this.enabled) return;
    this.enabled = next;
    this.publish(next);
  }

  clearListeners(): void {
    this.subscribers.clear();
  }

  private publish(enabled: boolean): void {
    for (const listener of this.subscribers) this.notifyOne(listener, enabled);
  }

  private notifyOne(listener: GateListener, enabled: boolean): void {
    try {
      listener(enabled);
    } catch (error) {
      reportExperimentsDiagnostic({
        kind: "gate_listener_failed",
        errorClass: errorLogTag(error),
      });
    }
  }
}
