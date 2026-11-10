import { dirname } from "node:path"

import { FileAutomationStore, getAgentAutomationsDir } from "../../automations/automation-store.ts"
import { getGlobalWorkflowsDir } from "../../workflows/workflow-library.ts"
import { FileWorkflowStore } from "../../workflows/workflow-store.ts"
import { FileChannelStore, getAgentChannelsDir } from "./channel-store.ts"

export interface UnavailableMemoryStore {
  recall(): { profile: never[]; recent: never[] }
  listMemories(): never[]
  addMemory(): null
  removeMemoryByContent(): false
  getLocation(): null
  setOnChange(): void
  removeMemory(): false
  clearMemories(): void
}

export function createUnavailableMemoryStore(): UnavailableMemoryStore {
  return {
    recall: () => ({ profile: [], recent: [] }),
    listMemories: () => [],
    addMemory: () => null,
    removeMemoryByContent: () => false,
    getLocation: () => null,
    setOnChange: () => {},
    removeMemory: () => false,
    clearMemories: () => {},
  }
}

export const NO_SESSION_MEMORY = {
  createAgentStore: createUnavailableMemoryStore,
  agentHasContent: () => false,
}

function owningAgentDirectory(databaseFile: string): string {
  return dirname(databaseFile)
}

function sharedStateRoot(agentDirectory: string): string {
  return dirname(dirname(agentDirectory))
}

export function automationStoreForDbPath(
  databaseFile: string,
  resolveUserTimeZone: () => string | undefined = () => undefined,
): FileAutomationStore {
  const agentDirectory = owningAgentDirectory(databaseFile)
  return new FileAutomationStore(getAgentAutomationsDir(agentDirectory), resolveUserTimeZone)
}

export function workflowStoreForDbPath(
  databaseFile: string,
  resolveUserTimeZone: () => string | undefined = () => undefined,
): FileWorkflowStore {
  const agentDirectory = owningAgentDirectory(databaseFile)
  const sharedWorkflowsDirectory = getGlobalWorkflowsDir(sharedStateRoot(agentDirectory))
  return new FileWorkflowStore(agentDirectory, sharedWorkflowsDirectory, resolveUserTimeZone)
}

export function channelStoreForDbPath(databaseFile: string): FileChannelStore {
  return new FileChannelStore(getAgentChannelsDir(owningAgentDirectory(databaseFile)))
}
