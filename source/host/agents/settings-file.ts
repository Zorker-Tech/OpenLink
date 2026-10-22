/**
 * An agent's own settings.
 *
 * Two switches — whether updates notify and whether the agent is hidden from the sidebar — kept in one file beside
 * the agent, written atomically, and defaulted when the file says nothing about them.
 */
import { mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";

export const SLATE_SETTINGS_FILENAME = "settings.json";
export const DEFAULT_NOTIFY_ON_AGENT_UPDATES = true;
export const DEFAULT_HIDDEN_FROM_SIDEBAR = false;

export interface AgentSettings {
  notifyOnAgentUpdates: boolean;
  hiddenFromSidebar: boolean;
}

export function getSlateSettingsPath(agentDir: string): string {
  return join(agentDir, SLATE_SETTINGS_FILENAME);
}

/** What the file holds, as a record; a file that is missing, unreadable or not a record holds nothing. */
function readRawSettings(path: string): Record<string, unknown> {
  try {
    const parsed: unknown = JSON.parse(readFileSync(path, "utf8"));
    return typeof parsed === "object" && parsed !== null && !Array.isArray(parsed) ? (parsed as Record<string, unknown>) : {};
  } catch {
    return {};
  }
}

/** A switch as the file holds it, or the answer this build gives when the file does not say. */
function switchIn(raw: Record<string, unknown>, field: keyof AgentSettings, fallback: boolean): boolean {
  const value = raw[field];
  return typeof value === "boolean" ? value : fallback;
}

export function agentSettingsAt(path: string): AgentSettings {
  const raw = readRawSettings(path);
  return {
    notifyOnAgentUpdates: switchIn(raw, "notifyOnAgentUpdates", DEFAULT_NOTIFY_ON_AGENT_UPDATES),
    hiddenFromSidebar: switchIn(raw, "hiddenFromSidebar", DEFAULT_HIDDEN_FROM_SIDEBAR),
  };
}

/**
 * Writes the settings the caller changed beside the agent, leaving the ones it did not mention as the file had them.
 *
 * The new content lands in a file of its own and is renamed over the old one, so a reader never sees half a record.
 */
export function writeAgentSettings(path: string, update: Partial<AgentSettings>): void {
  mkdirSync(dirname(path), { recursive: true });
  const temporary = `${path}.${process.pid}.${Date.now()}.tmp`;
  writeFileSync(temporary, `${JSON.stringify({ ...readRawSettings(path), ...update }, null, 2)}\n`, "utf8");
  renameSync(temporary, path);
}
