import {
  MountedAgentStoreKind,
  type MountedAgentStore,
} from "../proto/generated/agent/v1/request_context_exec_pb.ts"
import type { AutomationMemoryMount } from "../../../packages/agent/prompts/bug_report/automations.ts"

export function adaptMountedAgentStoresForAutomationMemory(
  stores: readonly MountedAgentStore[],
): AutomationMemoryMount[] {
  return stores
    .filter(store => store.kind === MountedAgentStoreKind.PRINCIPAL)
    .map(store => ({
      ...(store.alias === undefined ? {} : { alias: store.alias }),
      path: store.path,
    }))
}
