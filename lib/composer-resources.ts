import type { AgentKind } from '@/lib/chat-session-types'
import type { UserSkill } from '@/lib/user-skill-types'

/** Data that can safely be rendered in the composer.  The contents come from
 * the authenticated user's saved settings and are inserted into the next
 * message only after an explicit menu selection. */
export interface ComposerResources {
  agent: AgentKind
  skills: UserSkill[]
  customInstructions: string
}

export interface RuntimeComposerResources {
  agent: AgentKind
  source: string
  accessMode: 'restricted' | 'ask' | 'open'
  mcpServers: Array<{ id: string; name: string }>
  imageGeneration: boolean
  /** Native commands returned by this session's agent runtime. */
  commands: Array<{
    name: string
    description: string
    source: 'builtin' | 'extension' | 'prompt' | 'skill'
  }>
}

/** Dynamic prompt candidates returned by the selected session's native Agent.
 * `path` is a canonical Codex mention target (file path, plugin://, app:// or
 * thread://), never a browser-invented identifier. */
export interface RuntimePromptResource {
  id: string
  type: 'skill' | 'plugin' | 'app' | 'file' | 'thread' | 'model' | 'mode' | 'mcp' | 'permission'
  label: string
  description: string
  /** Right-aligned status used by read-only native inventories such as MCP. */
  secondaryContent?: string
  insertText: string
  group: string
  command?: string
  path?: string
}

/** Display-safe snapshot of the current machine's Codex runtime. Plugin
 * manifests retain Codex's official .codex-plugin/plugin.json fields. */
export interface CodexSkillResource {
  id: string
  name: string
  description: string
  source: 'builtin' | 'plugin'
  pluginId?: string
  defaultPrompt?: string
}

export interface CodexPluginResource {
  pluginId: string
  name: string
  marketplaceName: string
  version: string
  installed: boolean
  enabled: boolean
  installPolicy: string
  authPolicy: string
  displayName: string
  shortDescription: string
  longDescription: string
  developerName: string
  category: string
  capabilities: string[]
  homepage: string | null
  repository: string | null
  license: string | null
  keywords: string[]
  websiteUrl: string | null
  privacyPolicyUrl: string | null
  termsOfServiceUrl: string | null
  defaultPrompts: string[]
}

export interface CodexComposerResources {
  skills: CodexSkillResource[]
  plugins: CodexPluginResource[]
}
