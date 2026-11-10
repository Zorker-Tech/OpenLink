import { homedir } from "node:os"
import { AUTOMATION_UI_LIMIT } from "../../automations/automation.ts"
import { limitSurfacedWorkflows, type WorkflowSpec } from "../../../shared/workflow-model.ts"
import { getAgentDbPath } from "./session-paths.ts"
import {
  automationStoreForDbPath,
  channelStoreForDbPath,
  workflowStoreForDbPath,
} from "./session-store-factories.ts"
import type { SlateConnectorSecretStore } from "./connector-secret-store.ts"

type AutomationStore = ReturnType<typeof automationStoreForDbPath>
type WorkflowStore = ReturnType<typeof workflowStoreForDbPath>

export class SessionSubresources {
  constructor(
    private readonly rootDir: string,
    private readonly resolveUserTimeZone: () => string | undefined,
    private readonly connectorSecrets: SlateConnectorSecretStore,
  ) {}

  automationStore(agentId: string): AutomationStore {
    return automationStoreForDbPath(getAgentDbPath(this.rootDir, agentId), this.resolveUserTimeZone)
  }

  listAutomations(agentId: string) {
    return this.automationStore(agentId).list().slice(0, AUTOMATION_UI_LIMIT)
  }

  setAutomationEnabled(agentId: string, automationId: string, enabled: boolean) {
    return this.#changeAutomations(agentId, store => store.setEnabled(automationId, enabled))
  }

  createAutomation(
    agentId: string,
    spec: Parameters<AutomationStore["upsert"]>[0],
  ) {
    return this.#changeAutomations(agentId, store => store.upsert(spec))
  }

  updateAutomation(
    agentId: string,
    automationId: string,
    spec: Parameters<AutomationStore["update"]>[1],
  ) {
    return this.#changeAutomations(agentId, store => store.update(automationId, spec))
  }

  removeAutomation(agentId: string, automationId: string) {
    return this.#changeAutomations(agentId, store => store.remove(automationId))
  }

  workflowStore(agentId: string): WorkflowStore {
    return workflowStoreForDbPath(getAgentDbPath(this.rootDir, agentId), this.resolveUserTimeZone)
  }

  listWorkflows(agentId: string) {
    return limitSurfacedWorkflows(this.workflowStore(agentId).listAll())
  }

  getWorkflow(agentId: string, workflowId: string) {
    return this.workflowStore(agentId).get(workflowId)
  }

  createWorkflow(agentId: string, spec: WorkflowSpec) {
    return this.#changeWorkflows(agentId, store => store.create(spec))
  }

  updateWorkflow(agentId: string, workflowId: string, spec: WorkflowSpec) {
    return this.#changeWorkflows(agentId, store => store.update(workflowId, spec))
  }

  setWorkflowEnabled(agentId: string, workflowId: string, enabled: boolean) {
    return this.#changeWorkflows(agentId, store => store.setEnabledForAgent(workflowId, enabled))
  }

  removeWorkflow(agentId: string, workflowId: string) {
    return this.#changeWorkflows(agentId, store => store.remove(workflowId))
  }

  importWorkflowMarkdown(agentId: string, markdown: string, fallbackName?: string) {
    const store = this.workflowStore(agentId)
    const imported = store.importMarkdown(markdown, fallbackName)
    return {
      workflows: limitSurfacedWorkflows(store.listAll()),
      result: imported === null
        ? { imported: [], skipped: [{ source: "pasted skill", reason: "empty or invalid" }] }
        : { imported: [imported], skipped: [] },
    }
  }

  importWorkflowSource(agentId: string, source: string, fallbackName?: string) {
    const store = this.workflowStore(agentId)
    const imported = store.importLiveSource(source, fallbackName)
    return {
      workflows: limitSurfacedWorkflows(store.listAll()),
      result: imported === null
        ? { imported: [], skipped: [{ source, reason: "could not link" }] }
        : { imported: [imported], skipped: [] },
    }
  }

  portLocalSkills(agentId: string) {
    const store = this.workflowStore(agentId)
    return {
      workflows: limitSurfacedWorkflows(store.listAll()),
      result: store.portLocalSkills(homedir(), process.cwd()),
    }
  }

  channelStore(agentId: string) {
    return channelStoreForDbPath(getAgentDbPath(this.rootDir, agentId))
  }

  listChannels(agentId: string) {
    return this.channelStore(agentId)
      .listConnections()
      .filter(connection =>
        this.connectorSecrets.getSecret(agentId, connection.platform, "token") !== null
      )
  }

  listChannelConfigs(agentId: string): Array<{ platform: string; token: string; label: string }> {
    const store = this.channelStore(agentId)
    const configs: Array<{ platform: string; token: string; label: string }> = []
    for (const platform of store.listPlatforms()) {
      const token = this.connectorSecrets.getSecret(agentId, platform, "token")
      if (token !== null) {
        configs.push({ platform, token, label: store.readLabel(platform) ?? platform })
      }
    }
    return configs
  }

  storeCredential(agentId: string, platform: string, field: string, value: string): boolean {
    if (!this.connectorSecrets.setSecret(agentId, platform, field, value)) return false
    this.channelStore(agentId).writeMetadata(platform, "")
    return true
  }

  disconnectChannel(agentId: string, platform: string): boolean {
    this.connectorSecrets.removeAgentPlatform(agentId, platform)
    return this.channelStore(agentId).remove(platform)
  }

  #changeAutomations(agentId: string, change: (store: AutomationStore) => void) {
    const store = this.automationStore(agentId)
    change(store)
    return store.list().slice(0, AUTOMATION_UI_LIMIT)
  }

  #changeWorkflows(agentId: string, change: (store: WorkflowStore) => void) {
    const store = this.workflowStore(agentId)
    change(store)
    return limitSurfacedWorkflows(store.listAll())
  }
}
