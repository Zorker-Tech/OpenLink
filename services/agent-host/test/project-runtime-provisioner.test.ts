import assert from 'node:assert/strict'
import test from 'node:test'
import {
  ProjectRuntimeProvisioner,
  SupabaseProjectRuntimeProvisioningQueue,
  type ProjectRuntimeProvisioningQueue,
} from '../src/project-runtime-provisioner.js'

const projectId = '2c51ca26-3cd0-4cb4-896d-2061de06098c'

test('eagerly provisions a claimed Project and completes its lease', async () => {
  const calls: string[] = []
  const queue: ProjectRuntimeProvisioningQueue = {
    claim: async () => ({ projectId, attempt: 1, diskMode: 'thick' }),
    renew: async () => true,
    complete: async (id) => { calls.push(`complete:${id}`) },
    fail: async () => { throw new Error('unexpected failure') },
  }
  const provisioner = new ProjectRuntimeProvisioner({
    queue,
    runtimeManager: { ensure: async (id, diskMode) => { calls.push(`ensure:${id}:${diskMode}`); return {} as never } },
  })

  assert.equal(await provisioner.runOnce(), true)
  assert.deepEqual(calls, [`ensure:${projectId}:thick`, `complete:${projectId}`])
})

test('schedules a durable retry when provisioning fails', async () => {
  let retryAt: Date | undefined
  const queue: ProjectRuntimeProvisioningQueue = {
    claim: async () => ({ projectId, attempt: 2, diskMode: 'thin' }),
    renew: async () => true,
    complete: async () => { throw new Error('unexpected completion') },
    fail: async (_id, _worker, value) => { retryAt = value },
  }
  const before = Date.now()
  const provisioner = new ProjectRuntimeProvisioner({
    queue,
    runtimeManager: { ensure: async () => { throw new Error('VM failed') } },
    retryBaseMs: 1_000,
  })

  assert.equal(await provisioner.runOnce(), true)
  assert.ok(retryAt)
  assert.ok(retryAt.getTime() >= before + 2_000)
})

test('claims runtime rows with an atomic conditional PATCH', async () => {
  const requests: Array<{ url: string; init: RequestInit }> = []
  const queue = new SupabaseProjectRuntimeProvisioningQueue({
    url: 'https://backend.example.test',
    serviceRoleKey: 'server-secret',
    fetch: async (input, init = {}) => {
      requests.push({ url: String(input), init })
      if (init.method === 'GET') {
        return Response.json([{ project_id: projectId, provisioning_attempts: 0, disk_mode: 'thick' }])
      }
      return Response.json([{ project_id: projectId, provisioning_attempts: 1, disk_mode: 'thick' }])
    },
  })

  assert.deepEqual(await queue.claim('agent-test', 60_000), { projectId, attempt: 1, diskMode: 'thick' })
  assert.equal(requests.length, 2)
  const candidateUrl = new URL(requests[0]?.url ?? '')
  assert.match(candidateUrl.searchParams.get('and') ?? '', /^\(or\(.+\),or\(.+\)\)$/)
  assert.doesNotMatch(candidateUrl.searchParams.get('and') ?? '', /^and\(/)
  assert.equal(requests[1]?.init.method, 'PATCH')
  assert.match(requests[1]?.url ?? '', /provisioning_lease_expires_at/)
  assert.equal((requests[1]?.init.headers as Record<string, string>).Authorization, 'Bearer server-secret')
  assert.equal((requests[1]?.init.headers as Record<string, string>)['Content-Profile'], 'openlink')
  const body = JSON.parse(String(requests[1]?.init.body)) as Record<string, unknown>
  assert.equal(body.status, 'provisioning')
  assert.equal(body.provisioning_claimed_by, 'agent-test')
})
