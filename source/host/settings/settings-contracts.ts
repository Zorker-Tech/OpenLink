import type { SlateAgentModelSelection } from "../../shared/agents/slate-agent-model.ts"
import type { SlateAutoReviewInstructions } from "../../shared/slate-auto-review-instructions.ts"
import type { SidebarSection } from "../../shared/sidebar-sections.ts"

/** Partial settings update accepted by the host-facing settings service. */
export interface HostSettingsUpdate {
  notifications?: unknown
  mcpCustomInstructions?: Record<string, string>
  mcpCustomInstructionsByServerId?: Record<string, string>
  mcpDisabledToolsByServerId?: Record<string, string[]>
  mcpCustomInstructionsAccountScope?: string | null
  mcpBoxServers?: string[]
  userTimeZone?: string
  userTimeZoneOverride?: string
  agentDefaultModel?: SlateAgentModelSelection | null
  computerUseModel?: SlateAgentModelSelection | null
  autoReviewInstructions?: SlateAutoReviewInstructions
  localToolPermission?: unknown
  webauthnProxyEnabled?: boolean
  pinnedAgentIds?: string[]
  sidebarSections?: SidebarSection[]
  hasSeenOnboarding?: boolean
  featureFlagOverrides?: Record<string, boolean>
  inferenceProvider?: unknown
}
