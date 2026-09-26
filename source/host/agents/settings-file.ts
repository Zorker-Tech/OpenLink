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

export interface SlateAgentSettings { notifyOnAgentUpdates: boolean; hiddenFromSidebar: boolean }

export function getSlateSettingsPath(agentDir: string): string { return join(agentDir, SLATE_SETTINGS_FILENAME); }

function readRawSettings(path: string): Record<string, unknown> {
  try {
    const parsed: unknown = JSON.parse(readFileSync(path, "utf8"));
    return typeof parsed === "object" && parsed !== null && !Array.isArray(parsed) ? parsed as Record<string, unknown> : {};
  } catch { return {}; }
}

export function readSlateSettingsFile(path: string): SlateAgentSettings {
  const raw = readRawSettings(path);
  return {
    notifyOnAgentUpdates: typeof raw.notifyOnAgentUpdates === "boolean" ? raw.notifyOnAgentUpdates : DEFAULT_NOTIFY_ON_AGENT_UPDATES,
    hiddenFromSidebar: typeof raw.hiddenFromSidebar === "boolean" ? raw.hiddenFromSidebar : DEFAULT_HIDDEN_FROM_SIDEBAR
  };
}

export function writeSlateSettingsFile(path: string, update: Partial<SlateAgentSettings>): void {
  mkdirSync(dirname(path), { recursive: true });
  const temporary = `${path}.${process.pid}.${Date.now()}.tmp`;
  writeFileSync(temporary, `${JSON.stringify({ ...readRawSettings(path), ...update }, null, 2)}\n`, "utf8");
  renameSync(temporary, path);
}
