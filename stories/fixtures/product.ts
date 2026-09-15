import type { ProjectSummary } from '@/lib/projects'
import type { ActiveWorkspaceSummary } from '@/components/workspace-switcher'
import type { UserPreferences } from '@/lib/user-preference-types'

export const workspace = {
  activeWorkspace: { name: '演示工作区', slug: 'storybook', scopeType: 'personal', organizationId: null } satisfies ActiveWorkspaceSummary,
  personalWorkspace: { name: '演示工作区', slug: 'storybook' },
  organizations: [], nickname: 'Demo', email: 'demo@example.test', avatarUrl: null,
}
export const preferences: UserPreferences = { theme: 'dark', locale: 'zh-CN', chatPosition: 'left', customInstructions: '修改代码后运行测试。' }
export const project: ProjectSummary = {
  id: 'fixture-project', workspace_id: 'fixture-workspace', created_by: 'fixture-owner',
  name: 'OpenLink Demo', slug: 'demo', kind: 'code', source_type: 'blank', source_url: null,
  description: '本地演示数据，不连接真实运行时。', status: 'active', runtime_status: 'ready', runtime_error: null,
  runtime_phase: 'ready', runtime_phase_updated_at: null, runtime_provisioning_attempts: 1,
  runtime_provisioning_next_attempt_at: null, runtime_provisioning_lease_expires_at: null,
  runtime_claimed: false, is_default: true, disk_mode: 'thin', execution_mode: 'local',
  ssh_host: null, ssh_port: null, ssh_user: null, ssh_remote_root: null, ssh_known_hosts: null,
  ssh_private_key_hint: null, created_at: '2026-09-12T00:00:00Z', updated_at: '2026-09-12T00:00:00Z',
}
