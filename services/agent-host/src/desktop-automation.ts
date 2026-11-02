import type { ProjectRuntimeDescriptor } from './project-runtime.js'

/**
 * T1/T2 own a project-scoped desktop. Agent sessions run in a separate
 * OpenSandbox container, so the desktop capability has to be mounted into the
 * session explicitly: the CLI side-by-side helper, the session D-Bus, the
 * AT-SPI bus and (for T2) the Wayland socket. E1 keeps its per-chat container
 * desktop and does not receive the project desktop bridge.
 */
export interface DesktopAutomationVolume {
  name: string
  host: { path: string }
  mountPath: string
  readOnly: boolean
  [key: string]: unknown
}

export interface DesktopAutomationSkillFile {
  path: string
  data: string
}

export const AGENT_DESKTOP_SKILL = `---
name: agent-desktop
description: Use the project's Ubuntu desktop for native GUI apps, windows, dialogs, menus, and visible desktop interaction.
---

# Agent Desktop

The project has a real Ubuntu GNOME desktop. Prefer the session's native
\`desktop_*\` tools for GUI work; they use the same bridge as this CLI. Use the
\`agent-desktop\` CLI as the shell fallback, especially when you need flags or
diagnostics not exposed by the native tools.

Use desktop tools when the task involves native applications, OS dialogs,
windows, menus, or the visible desktop. For web-only work, prefer browser tools
when they are available; use the desktop path when the user asks for visible
browser or desktop interaction.

Before the first snapshot in a session, read the version-matched guide:

\`\`\`bash
agent-desktop skills get desktop
agent-desktop skills get platform
\`\`\`

The loop is always observe → act → observe again:

\`\`\`bash
agent-desktop list-apps
agent-desktop snapshot --app <app-name> -i --compact
agent-desktop click @<snapshot>:e<id>
agent-desktop snapshot --app <app-name> -i
\`\`\`

Rules:

- Refs belong to one snapshot. Take a new snapshot after the UI changes.
- Use \`--window-id\` when several windows match.
- Keep actions semantic where possible; prefer click/type/set-value over
  coordinate mouse input.
- The desktop is project-scoped and shared by every chat. Do not close or stop
  the desktop session itself.
- This tool is available for T1/T2 project desktops. Do not look for X11-only
  tools; T2 is a Wayland session and the CLI already uses the right backend.
`

export function desktopAutomationAvailable(runtime: ProjectRuntimeDescriptor | undefined): boolean {
  if (!runtime) return false
  const architecture = runtime.architecture ?? (runtime.backend === 'podman-machine' ? 'e1' : 't1')
  return architecture === 't1' || architecture === 't2'
}

export function desktopAutomationEnvironment(_runtime: ProjectRuntimeDescriptor): Record<string, string> {
  return {
    OPENLINK_DESKTOP_AUTOMATION: 'agent-desktop',
    OPENLINK_DESKTOP_TOOL_SOCKET: '/run/user/1000/openlink-desktop-tool.sock',
    OPENLINK_DESKTOP_EXTENSION_PATH: '/opt/openlink/agent-worker/extensions/openlink-desktop.ts',
  }
}

export function desktopAutomationVolumes(_runtime: ProjectRuntimeDescriptor): DesktopAutomationVolume[] {
  return [
    {
      name: 'agent-desktop-cli',
      host: { path: '/usr/local/bin/openlink-agent-desktop' },
      mountPath: '/usr/local/bin/agent-desktop',
      readOnly: true,
    },
    {
      name: 'agent-desktop-bridge',
      host: { path: '/run/user/1000/openlink-desktop-tool.sock' },
      mountPath: '/run/user/1000/openlink-desktop-tool.sock',
      readOnly: true,
    },
  ]
}

export function desktopAutomationSkillDirectories(): string[] {
  return [
    '/root/.pi/agent/skills/agent-desktop',
    '/root/.codex/skills/agent-desktop',
    '/home/openlink/.pi/agent/skills/agent-desktop',
    '/home/openlink/.codex/skills/agent-desktop',
  ]
}

export function desktopAutomationSkillFiles(): DesktopAutomationSkillFile[] {
  return desktopAutomationSkillDirectories().map((directory) => ({
    path: `${directory}/SKILL.md`,
    data: AGENT_DESKTOP_SKILL,
  }))
}
