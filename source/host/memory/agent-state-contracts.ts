/** Ports and result values for the state operations exposed to an agent. */
import type { MemoryKind } from "./memory-service.ts";

export type StateWriteResult = { ok: true; message: string } | { ok: false; message: string };
export const MEMORY_NOTE_PREFIX = "Note: ";
export const AVATAR_MAX_BYTES = 5 * 1024 * 1024;

export interface AgentStateMemoryPort {
  addMemory(content: string, at: number, kind: MemoryKind): { content: string } | null;
  removeMemoryByContent(content: string): boolean;
}

export interface AgentStateAutomationPort {
  upsert(spec: unknown, now?: number): { id: string; name: string; isEnabled?: boolean; trigger: import("../../shared/automations.ts").AutomationTrigger } | null;
  update(id: string, spec: unknown): { id: string; name: string; isEnabled?: boolean; trigger: import("../../shared/automations.ts").AutomationTrigger } | null;
  setEnabled(id: string, enabled: boolean): { id: string; name: string } | null;
  get(id: string): { name: string } | null;
  remove(id: string): boolean;
}

export interface AgentStateWorkflowPort {
  create(spec: unknown): { id: string; name: string } | null;
  update(id: string, spec: unknown): { id: string; name: string } | null;
  remove(id: string): boolean;
}

export interface AgentStateMembershipPort {
  read(): ReadonlySet<string>;
  join(slug: string): boolean;
  leave(slug: string): boolean;
}

export interface AgentStateDeps {
  agentId: string;
  agentDir: string;
  slateRoot: string;
  memory: AgentStateMemoryPort;
  membership: AgentStateMembershipPort;
  channels: { remove(platform: string): boolean };
  automations: AgentStateAutomationPort;
  workflows: AgentStateWorkflowPort;
  now?: () => number;
  readProfile(): Record<string, string> | null;
  writeProfile(profile: Record<string, string>): void;
  writeSettings(settings: Record<string, boolean>): void;
  readBoxFile?(path: string): Promise<Uint8Array>;
  onAvatarChanged?(): void;
}

export function stateWriteOk(message: string): StateWriteResult {
  return { ok: true, message };
}

export function stateWriteFailed(message: string): StateWriteResult {
  return { ok: false, message };
}

export function isBlankAgentText(value?: string | null): boolean {
  return value == null || value.trim().length === 0;
}
