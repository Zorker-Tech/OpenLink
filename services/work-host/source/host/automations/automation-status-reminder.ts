/** The pieces prompt assembly reads from an agent's local automation state. */
import type { AutomationRecord } from "./automation.ts";

export interface AutomationStatusSource {
  getLocation(): string | null | undefined;
  list(): readonly AutomationRecord[];
  listDefinitions?(): readonly AutomationRecord[];
}

export interface AutomationTimeZoneResolver {
  resolve(): { readonly timeZone?: string | undefined };
}
