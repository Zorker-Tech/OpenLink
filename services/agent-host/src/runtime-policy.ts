import { agentToolsAvailable } from './agent-tools.js'
import { desktopAutomationAvailable } from './desktop-automation.js'
import type { ProjectRuntimeDescriptor } from './project-runtime.js'

/**
 * Runtime policy injected by Agent Host into a session's native developer or
 * system instruction channel. It is intentionally short: full command usage
 * stays in the session skills. Its only job is capability truth and default
 * routing, so the model prefers project tools without guessing what is mounted.
 */
export const RUNTIME_POLICY_REVISION = '2026-11-03-runtime-policy-v1'

export function runtimePolicyFor(runtime: ProjectRuntimeDescriptor | undefined): string | undefined {
  if (!runtime) return undefined
  const architecture = runtime.architecture ?? (runtime.backend === 'podman-machine' ? 'e1' : 't1')
  const desktop = desktopAutomationAvailable(runtime)
  const agentTools = agentToolsAvailable(runtime)
  if (!desktop && !agentTools) return undefined

  const lines = [
    '## OpenLink Runtime Capabilities',
    '',
    `This session is attached to a ${architecture.toUpperCase()} OpenLink project runtime.`,
    'Treat the following as environment routing, not as a replacement for the user or project instructions.',
    '',
    'Routing rules:',
    '- Code, files, terminal work, and data inspection belong to the normal coding tools.',
  ]
  if (desktop) {
    lines.push(
      '- For native GUI applications, OS dialogs, windows, menus, and tasks that require the visible Ubuntu desktop, use the desktop tools first (desktop_status, desktop_list_apps, desktop_snapshot, desktop_click, desktop_type, desktop_press, desktop_launch). The `agent-desktop` CLI is the equivalent shell fallback.',
      '- For web-only work, prefer the browser tools when they are available. Use desktop tools when the user explicitly asks for visible browser or desktop interaction.',
      '- Do not infer GUI state from screenshots when desktop_status or desktop_snapshot can answer it; observe before acting and observe again after an action.',
    )
  }
  if (agentTools) {
    lines.push(
      '- Project-scoped CLI tools are exposed through the Agent Tool Registry. Read /openlink/agent-tools/manifest.tsv before guessing that a tool is unavailable.',
      '- Use a registered project tool by its manifest name; do not reinstall or copy it unless the user asks.',
    )
  }
  lines.push(
    '- Only advertise or use capabilities listed here. Never invent a mounted tool or path.',
    '- This policy describes capabilities. User and project instructions still decide the task and its constraints.',
  )
  return lines.join('\n')
}

export function runtimePolicyEnvironment(runtime: ProjectRuntimeDescriptor | undefined): Record<string, string> {
  const policy = runtimePolicyFor(runtime)
  if (!policy) return {}
  return {
    OPENLINK_AGENT_RUNTIME_POLICY: policy,
    OPENLINK_AGENT_RUNTIME_POLICY_REVISION: RUNTIME_POLICY_REVISION,
  }
}
