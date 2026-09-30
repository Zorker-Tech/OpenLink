/** The stores a session opens: each is built from the same ports, so a session's pieces are wired the same way everywhere. */
import { dirname } from "node:path";
import { FileAutomationStore, getAgentAutomationsDir } from "../../automations/automation-store.ts";
import { getGlobalWorkflowsDir } from "../../workflows/workflow-library.ts";
import { FileWorkflowStore } from "../../workflows/workflow-store.ts";
import { FileChannelStore, getAgentChannelsDir } from "./channel-store.ts";

export interface UnavailableMemoryStore { recall(): { profile: never[]; recent: never[] }; listMemories(): never[]; addMemory(): null; removeMemoryByContent(): false; getLocation(): null; setOnChange(): void; removeMemory(): false; clearMemories(): void }
export function createUnavailableMemoryStore(): UnavailableMemoryStore { return { recall: () => ({ profile: [], recent: [] }), listMemories: () => [], addMemory: () => null, removeMemoryByContent: () => false, getLocation: () => null, setOnChange: () => {}, removeMemory: () => false, clearMemories: () => {} }; }
export const NO_SESSION_MEMORY = { createAgentStore: () => createUnavailableMemoryStore(), agentHasContent: () => false };
export function automationStoreForDbPath(dbPath: string, resolveUserTimeZone: () => string | undefined = () => undefined): FileAutomationStore { return new FileAutomationStore(getAgentAutomationsDir(dirname(dbPath)), resolveUserTimeZone); }
export function workflowStoreForDbPath(dbPath: string, resolveUserTimeZone: () => string | undefined = () => undefined): FileWorkflowStore { const agentDir = dirname(dbPath), slateRoot = dirname(dirname(agentDir)); return new FileWorkflowStore(agentDir, getGlobalWorkflowsDir(slateRoot), resolveUserTimeZone); }
export function channelStoreForDbPath(dbPath: string): FileChannelStore { return new FileChannelStore(getAgentChannelsDir(dirname(dbPath))); }
