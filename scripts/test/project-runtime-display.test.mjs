import assert from 'node:assert/strict'
import test from 'node:test'
import { projectRuntimeDisplay } from '../../lib/project-runtime-display.ts'

const now = Date.parse('2026-09-08T01:00:00Z')
const base = {
  status: 'waiting', runtime_status: 'provisioning', runtime_phase: 'queued',
  runtime_phase_updated_at: '2026-09-08T00:59:00Z', runtime_provisioning_attempts: 0,
  runtime_provisioning_next_attempt_at: null, runtime_provisioning_lease_expires_at: null,
  runtime_claimed: false, runtime_error: null,
}

test('distinguishes missing, queued, claimed and concrete VM provisioning phases', () => {
  assert.equal(projectRuntimeDisplay({ ...base, runtime_status: null, runtime_phase: null }, now).label, '尚未进入初始化队列')
  assert.equal(projectRuntimeDisplay(base, now).label, '等待调度')
  assert.equal(projectRuntimeDisplay({ ...base, runtime_claimed: true, runtime_phase: 'claimed', runtime_provisioning_attempts: 2, runtime_provisioning_lease_expires_at: '2026-09-08T01:05:00Z' }, now).label, '调度器已认领')
  assert.equal(projectRuntimeDisplay({ ...base, runtime_claimed: true, runtime_phase: 'starting_vm' }, now).label, '正在启动 VM')
  assert.equal(projectRuntimeDisplay({ ...base, runtime_phase: 'starting_project_database' }, now).label, '正在启动项目数据库')
  assert.equal(projectRuntimeDisplay({ ...base, runtime_phase: 'starting_agent_services' }, now).label, '正在启动 Agent 服务')
})

test('distinguishes retries, expired leases, terminal failures and ready projection lag', () => {
  const retry = projectRuntimeDisplay({ ...base, runtime_status: 'error', runtime_phase: 'retry_wait', runtime_provisioning_attempts: 3, runtime_provisioning_next_attempt_at: '2026-09-08T01:02:00Z', runtime_error: 'token=private VM boot failed' }, now)
  assert.equal(retry.label, '初始化失败，等待自动重试')
  assert.match(retry.detail, /2 分钟后重试/)
  assert.equal(retry.diagnostic, 'token=<redacted> VM boot failed')
  assert.equal(projectRuntimeDisplay({ ...base, runtime_claimed: true, runtime_provisioning_lease_expires_at: '2026-09-08T00:59:00Z' }, now).label, '初始化任务租约已过期')
  assert.equal(projectRuntimeDisplay({ ...base, runtime_status: 'error', runtime_phase: 'failed' }, now).label, '初始化失败，已停止自动重试')
  assert.equal(projectRuntimeDisplay({ ...base, runtime_status: 'ready', runtime_phase: 'ready' }, now).label, '运行环境已就绪，项目状态同步中')
  assert.equal(projectRuntimeDisplay({ ...base, status: 'active', runtime_status: 'ready', runtime_phase: 'ready' }, now).ready, true)
})

test('does not present contradictory ready plus claimed state as usable', () => {
  const reconciling = projectRuntimeDisplay({ ...base, status: 'active', runtime_status: 'ready', runtime_phase: 'ready', runtime_claimed: true, runtime_provisioning_attempts: 78, runtime_provisioning_lease_expires_at: '2026-09-08T01:05:00Z' }, now)
  assert.equal(reconciling.ready, false)
  assert.equal(reconciling.label, '运行环境已上报就绪，正在完成调度')
  const expired = projectRuntimeDisplay({ ...base, status: 'active', runtime_status: 'ready', runtime_phase: 'ready', runtime_claimed: true, runtime_provisioning_lease_expires_at: '2026-09-08T00:59:00Z' }, now)
  assert.equal(expired.failed, true)
  assert.equal(expired.label, '运行状态冲突，调度租约已过期')
})
