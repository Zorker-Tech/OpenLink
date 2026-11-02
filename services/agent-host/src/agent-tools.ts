import { readFileSync } from 'node:fs'
import type { ProjectRuntimeDescriptor } from './project-runtime.js'

/**
 * Project-scoped CLI registry for tools installed by the user inside the
 * Project VM. The registry directory is mounted read-only into every Project
 * VM sandbox and prepended to PATH; the agent reads manifest.tsv to discover
 * what is available. This is intentionally narrower than mounting the VM's
 * PATH or /usr/local/bin.
 */
export const AGENT_TOOL_REGISTRY_ROOT = '/var/lib/openlink/agent-tools'
export const AGENT_TOOL_SANDBOX_ROOT = '/openlink/agent-tools'

export const AGENT_TOOLS_SKILL = `---
name: agent-tools
description: Project-scoped CLI tools installed by the user in this Project VM.
---

# Project Agent Tools

The project owner can install additional CLI tools into this Project VM with:

\`\`\`bash
sudo openlink-agent-tool add <name> <absolute-path> "<description>" "<usage>"
\`\`\`

Every project desktop session receives the registry read-only at
\`${AGENT_TOOL_SANDBOX_ROOT}\`; its \`bin\` directory is already on \`PATH\`.
Discover tools by reading:

\`\`\`bash
cat ${AGENT_TOOL_SANDBOX_ROOT}/manifest.tsv
ls -l ${AGENT_TOOL_SANDBOX_ROOT}/bin
\`\`\`

The manifest is tab-separated with the columns:

\`\`\`text
name<TAB>entrypoint<TAB>description<TAB>usage<TAB>sha256
\`\`\`

Run a registered tool by its name, exactly as documented in the usage column.
Tools are project-scoped, not per-chat; do not modify the read-only registry
from a session. If a tool needs files or libraries that are not in its bundled
entrypoint, use the project workspace or ask the owner to install it into the
session image instead.
`

function readAgentToolCli(): string {
  const candidates = [
    new URL('../../openlink-agent-tool.sh', import.meta.url),
    new URL('../openlink-agent-tool.sh', import.meta.url),
  ]
  let lastError: unknown
  for (const candidate of candidates) {
    try {
      return readFileSync(candidate, 'utf8')
    } catch (error) {
      lastError = error
    }
  }
  throw new Error(`Project agent tool CLI is missing: ${lastError instanceof Error ? lastError.message : String(lastError)}`)
}

export const AGENT_TOOL_CLI = readAgentToolCli()

export function agentToolsAvailable(runtime: ProjectRuntimeDescriptor | undefined): boolean {
  return Boolean(runtime)
}

export function agentToolRegistryEnvironment(): Record<string, string> {
  return {
    OPENLINK_AGENT_TOOL_REGISTRY: AGENT_TOOL_SANDBOX_ROOT,
    PATH: `${AGENT_TOOL_SANDBOX_ROOT}/bin:/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin`,
  }
}

export function agentToolRegistryVolume(): {
  name: string
  host: { path: string }
  mountPath: string
  readOnly: boolean
  [key: string]: unknown
} {
  return {
    name: 'agent-tool-registry',
    host: { path: AGENT_TOOL_REGISTRY_ROOT },
    mountPath: AGENT_TOOL_SANDBOX_ROOT,
    readOnly: true,
  }
}

export function agentToolsSkillDirectories(): string[] {
  return [
    '/root/.pi/agent/skills/agent-tools',
    '/root/.codex/skills/agent-tools',
    '/home/openlink/.pi/agent/skills/agent-tools',
    '/home/openlink/.codex/skills/agent-tools',
  ]
}

export function agentToolsSkillFiles(): Array<{ path: string; data: string }> {
  return agentToolsSkillDirectories().map((directory) => ({
    path: `${directory}/SKILL.md`,
    data: AGENT_TOOLS_SKILL,
  }))
}
