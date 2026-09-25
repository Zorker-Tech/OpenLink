/**
 * A switch that can be read, set, and watched.
 *
 * Listeners are told when the value actually changes, and one listener that throws does not stop the others: the
 * failure is reported as a diagnostic and the rest are told, since a switch is shared and one bad listener must not
 * take the rest of the platform with it.
 */
import { errorLogTag } from "../../errors/summary.ts";
import { reportExperimentsDiagnostic } from "./experiments-diagnostics.ts";
export class MutableGateProperty {
  private readonly listeners = new Set<(value: boolean) => void>();
  constructor(private value: boolean) {}
  get(): boolean { return this.value; }
  subscribe(listener: (value: boolean) => void): () => void { this.listeners.add(listener); return () => this.listeners.delete(listener); }
  set(value: boolean): void { if (this.value === value) return; this.value = value; for (const listener of this.listeners) { try { listener(value); } catch (error) { reportExperimentsDiagnostic({ kind: "gate_listener_failed", errorClass: errorLogTag(error) }); } } }
  clearListeners(): void { this.listeners.clear(); }
}
