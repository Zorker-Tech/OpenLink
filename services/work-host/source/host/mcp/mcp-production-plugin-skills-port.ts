import type { McpPluginSkillsService } from "./extension.ts"
import type { PluginSkillsPort } from "./mcp-service.ts"
import { removeWorkflowLiveReferences } from "./legacy-live-references.ts"
import { toPluginSkillInfo } from "../skills/plugin-skills.ts"

export function projectPluginSkillsForMcpHost(
  service: McpPluginSkillsService,
  rootDirectory: string,
): PluginSkillsPort {
  return {
    sync: async trigger => (await service.sync(trigger)).map(record => toPluginSkillInfo(record)),
    status: () => ({ authBlocked: service.currentAuthBlocked() }),
    removeLiveReferences: sourceUrls => removeWorkflowLiveReferences(rootDirectory, sourceUrls),
  }
}
